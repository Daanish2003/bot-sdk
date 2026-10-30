import { ORPCError } from "@orpc/server";
import { maxFilesPerMessage, type SentFile } from "@botsdk/client/bot/files";
import { mentionedMembers } from "@botsdk/client/bot/mentions";
import type { BotMessage, TurnStatus } from "@botsdk/client/bot/turn";
import type { ModelMessage } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../chat/message-tree";
import { bot, botRoomMember, botTrigger, botTurn, message } from "../../storage";
import type { Database } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import type { MessageUsage } from "../../models/shared/usage";
import {
  defineCoreJob,
  PermanentJobError,
  loadHistory,
  createWorkflow,
  type WorkflowContext,
} from "../../runner/internal";

import {
  botTurnJobName,
  isPaused,
  lockConversation,
  lockConversationsInOrder,
  lockTurnConversations,
  oneToOnesOf,
  receive,
  runningTurnOf,
  startTurn,
  turnStarted,
  waitingIn,
} from "../triggers";
import {
  build,
  type ContextTurn,
  newestRenderer,
  recordedReads,
  type TodoItem,
  featuresAfterTurn,
  featureTurnChanges,
  featureTurnOf,
  queueAwaySummary,
  type TurnChanges,
  sendToUserToolName,
  checkedTool,
} from "../context";
import {
  hintChanged,
  recordBotChange,
  findBot,
  findRoom,
  oneBotRoom,
  userTimeZone,
  textParts,
  toBotMessage,
  turnTimeLimitMs,
  takeUploads,
} from "../conversation";
import { todoList } from "../helpers";
import { type LoopResult, runLoop, seesImagesOnce } from "../agent-loop";
import { closeWaitingReviews } from "../safety";

import { forTurn } from "../tools";

/** The most Steps a Turn may take; one more ends it `error` with `step_limit`. */
export const turnStepLimit = 10;

/**
 * The note a Turn adds as a user turn when a Step ends in plain text and no tool call, for one
 * more Step, at most once per Turn (#531). A recorded deviation: the lecture is silent here.
 *
 * Why, from the Turn eval (eval/turn, `EVAL_REPEATS=3`, both Models over OpenRouter): on the prompt
 * alone, Haiku 4.5 wrote refusals and questions as plain text the user never saw ("unavailable"
 * 1/3, "no-email" 0/3, "unclear" 1/3), and gpt-5.4-mini answered "no-live-data" in plain text (1/3).
 * With this note and the prompt above, all four refusal and question cases passed 3/3 on both
 * Models, structurally and with the judge, in two runs. Quiet cases: Haiku 19/30 before, 24/30
 * and 19/30 after; gpt-5.4-mini 30/30 before and after.
 */
export const undeliveredTextReminder =
  "(A note from the system, not from the user.) Your last reply was plain text, so it was not " +
  "delivered: the user never sees plain text. The user needs it only if it answers what they " +
  `asked, says you cannot do it, or asks them something: then send it with ${sendToUserToolName}. ` +
  "A thanks, a good luck, a goodbye or an offer of more help is not needed: reply with no text. " +
  "Do not answer this note.";

/** The first Checkpoint of a Turn's job, which starts the Turn (#501). */
const startTurnActivity = "start_turn";

/** The runner job of one Turn, keyed by the Turn's id (ADR 0011, the #482 amendment). */
export const botTurnJob = defineCoreJob({
  name: botTurnJobName,
  payload: z.object({ turnId: z.uuid() }),
  run: ({ turnId }, ctx) => runTurnJob(ctx.deps, turnId, ctx),
  onFailed: ({ turnId }, _error, { deps }) => endLostTurn(deps, turnId),
  onCancelled: ({ turnId }, { deps }) => endStoppedTurn(deps, turnId),
});

/**
 * Saves the user's Message and hands its Trigger to the Router, in one transaction: a Turn takes it
 * now or, while a Turn's job runs, that Turn is interrupted and the next one does. Checks run
 * before anything is written, and a refusal throws an RPC error. Returns the saved user Message
 * (the earlier one for a repeat of an earlier send); the Turn that takes it runs as a job, and the
 * Bot thread shows it through the change log (ADR 0026).
 * `timeZone` is the user's IANA zone, kept on the Message.
 */
export async function sendToBot(
  deps: BotSdkContext,
  {
    userId,
    botId,
    id,
    text,
    files: fileIds = [],
    timeZone,
  }: {
    userId: string;
    botId: string;
    id: string;
    text: string;
    files?: string[];
    timeZone?: string;
  },
): Promise<BotMessage> {
  const uploads = [...new Set(fileIds.map((fileId) => fileId.toLowerCase()))];
  if (uploads.length > maxFilesPerMessage) {
    throw rpcError(
      "BAD_REQUEST",
      "error.botFilesTooMany",
      `A message can carry at most ${maxFilesPerMessage} files`,
      { max: maxFilesPerMessage },
    );
  }
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const call = await deps.models.resolveModelCall(userId, found.model);
  if (!call) {
    throw rpcError(
      "BAD_REQUEST",
      "error.modelNotAvailable",
      `"${found.model}" is not an available Model`,
      { model: found.model },
    );
  }

  const sent = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in every transaction that starts or ends a Turn.
    await lockConversation(tx, found.conversationId);
    // A repeat of an earlier send (#498) is checked before the Quota, so a retry is never refused
    // while its own Turn runs or once the Quota is spent. It saves nothing and re-joins its Turn.
    const earlier = await seenMessage(tx, found.conversationId, id);
    if (earlier) return { userMessage: earlier, started: false, ended: false };
    // A paused Bot takes no Message (spec #1007), and saves none.
    if (await isPaused(tx, botId)) {
      throw rpcError("CONFLICT", "error.botPaused", "Bot is paused. Resume to send.");
    }
    // A Turn on Host credentials is refused once its Quota's window has spent the budget (ADR 0007),
    // before the user's Message is saved. It is checked here only, so a resumed Turn is never refused.
    if (!(await call.meter.mayRun()).ok) {
      throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
    }
    // Read under the lock, so no Turn starts between this time and the Message's commit.
    const now = deps.clock();
    // The uploads become the Message's `files` part (spec #801), which holds them from then on.
    const files = uploads.length ? await takeUploads(tx, userId, uploads) : [];
    const parts = textParts(text, timeZone);
    const row = await appendMessage(tx, found.conversationId, {
      id,
      role: "user",
      // A files-only Message stores no empty text part, as the email path doesn't.
      parts: files.length
        ? {
            ...parts,
            parts: [
              ...(text.trim() ? parts.parts : []),
              { type: "control", control: { kind: "files", files } },
            ],
          }
        : parts,
      status: "complete",
      createdAt: now,
    });
    const { waitsFor } = await receive(deps, tx, {
      id: row.id,
      botId,
      conversationId: found.conversationId,
      source: "user",
      channel: "web",
      messageId: row.id,
      receivedAt: now,
    });
    // The owner skips the line (#500): a Message sent while a Turn's job runs interrupts that Turn,
    // and the Turn that follows it takes the Message.
    const ended = waitsFor ? await cancelTurn(deps, tx, waitsFor, "message") : false;
    return { userMessage: toBotMessage(row), started: true, ended };
  });
  if (sent.started) deps.runner.wake();
  // Other tabs fetch the new Message (and the Turn this send interrupted, if any).
  if (sent.started) await hintChanged(deps, found.conversationId);
  return sent.userMessage;
}

/**
 * Saves the user's Message in their Room and hands it to the Router, in one transaction (spec
 * #1055): one Trigger for each member it @mentions, or one for the lead when it mentions none. Each
 * interrupts the running Turn of its own Bot in the Room only, as a send to the Bot does, so the
 * other Bots keep working. A paused Bot keeps its Trigger as skipped, and the lead is not woken in
 * its place. With no lead (its Bot was deleted), the earliest member leads. The Message keeps
 * `timeZone`, or else the user's newest one. `id` is the caller's id for the Message, as `bots.send`
 * takes it: a repeat of an earlier send saves nothing and returns the Message saved first. Returns
 * the saved user Message.
 */
export async function sendToRoom(
  deps: BotSdkContext,
  {
    userId,
    conversationId,
    id,
    text,
    timeZone,
  }: { userId: string; conversationId: string; id?: string; text: string; timeZone?: string },
): Promise<BotMessage> {
  const posted = await postToRoom(deps, {
    userId,
    conversationId,
    ...(id && { id, triggerId: id }),
    text,
    channel: "web",
    timeZone,
  });
  // A web send always has a Message: its id is the Trigger's.
  return posted.message!;
}

/**
 * Saves a user Message in their Room and routes it as `sendToRoom` says, on `channel`: the web
 * composer's, or an email reply to a Room Message (`subject`, and the `files` already stored). Each
 * Trigger has id `triggerId` (the Message's id when not given), so a repeat of it saves nothing:
 * `seen`, with the Message saved first, or with none when only the Trigger is known. Checks run
 * before anything is written, and a refusal throws an RPC error. `stillValid`, checked under the
 * locks, says whether the Channel still takes it (an email address rotated meanwhile): `refused`.
 */
export async function postToRoom(
  deps: BotSdkContext,
  {
    userId,
    conversationId,
    id,
    triggerId,
    text,
    channel,
    subject,
    files = [],
    timeZone,
    stillValid,
  }: {
    userId: string;
    conversationId: string;
    id?: string;
    triggerId?: string;
    text: string;
    channel: string;
    subject?: string;
    files?: SentFile[];
    timeZone?: string;
    stillValid?: (tx: Transaction) => Promise<boolean>;
  },
): Promise<{ outcome: "handed" | "seen" | "refused"; message?: BotMessage }> {
  const room = await findRoom(deps.db, userId, conversationId);
  if (room.members.length < 2) throw oneBotRoom();
  const mentioned = mentionedMembers(text, room.members);
  const lead = room.members.find((member) => member.lead) ?? room.members[0];
  const botIds = mentioned.length > 0 ? mentioned : lead ? [lead.botId] : [];
  // A paused Bot's Trigger is only kept as skipped, so its Model isn't asked for.
  const paused = new Set(room.members.flatMap((member) => (member.pausedAt ? [member.botId] : [])));
  const targets = await Promise.all(
    botIds.map(async (botId) => {
      const found = await findBot(deps.db, userId, botId);
      if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      if (paused.has(botId)) return { botId, call: undefined };
      const call = await deps.models.resolveModelCall(userId, found.model);
      if (!call) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${found.model}" is not an available Model`,
          { model: found.model },
        );
      }
      return { botId, call };
    }),
  );
  if (targets.length === 0) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const zone = timeZone ?? (await userTimeZone(deps.db, userId));
  const posted = await deps.db.transaction(async (tx) => {
    // The Room with its targets' 1:1 Conversations, in id order: an interrupted Turn's end writes both.
    await lockConversationsInOrder(tx, [
      conversationId,
      ...(await oneToOnesOf(
        tx,
        targets.map((target) => target.botId),
      )),
    ]);
    if (stillValid && !(await stillValid(tx))) return { outcome: "refused" as const };
    // A repeat of an earlier send (#498) is checked before the Quota, as `sendToBot` checks it.
    if (id) {
      const earlier = await seenMessage(tx, conversationId, id);
      if (earlier) return { outcome: "seen" as const, message: earlier };
    } else if (triggerId) {
      const [seen] = await tx
        .select({ id: botTrigger.id })
        .from(botTrigger)
        .where(eq(botTrigger.id, triggerId))
        .limit(1);
      if (seen) return { outcome: "seen" as const };
    }
    for (const { call } of targets) {
      if (call && !(await call.meter.mayRun()).ok) {
        throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
      }
    }
    const now = deps.clock();
    const parts = textParts(text, zone);
    const row = await appendMessage(tx, conversationId, {
      ...(id && { id }),
      role: "user",
      parts: {
        ...parts,
        parts: [
          // A Message of files alone carries no empty text part, as `handIn` saves it.
          ...(text ? parts.parts : []),
          ...(files.length
            ? [{ type: "control" as const, control: { kind: "files" as const, files } }]
            : []),
        ],
        ...(channel !== "web" && { channel }),
        ...(subject !== undefined && { subject }),
      },
      status: "complete",
      createdAt: now,
    });
    for (const { botId } of targets) {
      const { waitsFor } = await receive(deps, tx, {
        id: triggerId ?? row.id,
        botId,
        conversationId,
        source: "user",
        channel,
        messageId: row.id,
        receivedAt: now,
      });
      if (waitsFor) await cancelTurn(deps, tx, waitsFor, "message");
    }
    return { outcome: "handed" as const, message: toBotMessage(row) };
  });
  if (posted.outcome !== "handed") return posted;
  deps.runner.wake();
  await hintChanged(deps, conversationId);
  return posted;
}

/**
 * The user Message an earlier send of `id` saved in this Conversation, or `undefined` when `id` is
 * new. An id that a Message or Trigger of another Conversation already holds is `BAD_REQUEST`, which
 * says nothing about that row. Call it under the Conversation's row lock.
 */
async function seenMessage(
  tx: Transaction,
  conversationId: string,
  id: string,
): Promise<BotMessage | undefined> {
  const [row] = await tx.select().from(message).where(eq(message.id, id));
  const [trigger] = await tx
    .select({ conversationId: botTrigger.conversationId })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (!row && !trigger) return undefined;
  if (
    !row ||
    !trigger ||
    row.conversationId !== conversationId ||
    trigger.conversationId !== conversationId ||
    row.role !== "user"
  ) {
    throw rpcError("BAD_REQUEST", "error.messageIdTaken", "That message id is already used");
  }
  return toBotMessage(row);
}

/**
 * Stops the Bot's running Turn by cancelling its job (#482, #483), and starts nothing after it
 * (#500): in the same transaction, the Turn it stops takes every Trigger waiting in the
 * Conversation queue, so `turnEnded` finds the line empty. Their Messages stay, and the next Turn
 * reads them as history. Does nothing when no Turn is running. The Turn is the one in
 * `conversationId`, the Bot's 1:1 Conversation when not given, or one of its Rooms (spec #1055),
 * where the Tasks view shows it; a Conversation the Bot isn't in is not found.
 */
export async function stopBot(
  deps: BotSdkContext,
  userId: string,
  { botId, conversationId }: { botId: string; conversationId?: string },
): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const owner = { botId, conversationId: conversationId ?? found.conversationId };
  if (owner.conversationId !== found.conversationId) {
    const [member] = await deps.db
      .select({ botId: botRoomMember.botId })
      .from(botRoomMember)
      .where(
        and(eq(botRoomMember.conversationId, owner.conversationId), eq(botRoomMember.botId, botId)),
      );
    if (!member) throw rpcError("NOT_FOUND", "error.roomNotFound", "Room not found");
  }
  const ended = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in `sendToBot`; a Room Turn's end writes the 1:1 too.
    await lockTurnConversations(tx, owner);
    const running = await runningTurnOf(tx, owner);
    if (!running) return false;
    await tx.update(botTrigger).set({ turnId: running }).where(waitingIn(owner));
    return cancelTurn(deps, tx, running, "stop");
  });
  if (!ended) return;
  deps.runner.wake();
  await hintChanged(deps, owner.conversationId);
  if (owner.conversationId !== found.conversationId) await hintChanged(deps, found.conversationId);
}

/**
 * Stops every running Turn of each of the user's Bots, in their 1:1 Conversations and their Rooms
 * (spec #1055), as `stopBot` does (#585): a Ban calls it.
 */
export async function stopUserTurns(deps: BotSdkContext, userId: string): Promise<void> {
  const running = await deps.db
    .selectDistinct({ botId: botTurn.botId, conversationId: botTurn.conversationId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(and(eq(bot.userId, userId), eq(botTurn.status, "running")));
  for (const owner of running) {
    // A Bot deleted or removed from the Room meanwhile has nothing left to stop there.
    await stopBot(deps, userId, owner).catch((caught: unknown) => {
      if (!isNotFound(caught)) throw caught;
    });
  }
}

/** Whether `caught` is an RPC error with code `NOT_FOUND`. */
const isNotFound = (caught: unknown) => caught instanceof ORPCError && caught.code === "NOT_FOUND";

/**
 * Cancels Turn `turnId`'s job, unless it is already cancelled, under the Conversation's row lock
 * (#500). A queued job never runs again, so its Turn ends `stopped` here and the next Turn takes
 * what waits in the Conversation queue; a running one ends `stopped` as its attempt aborts
 * (`runTurnJob`), or in `onCancelled` when that attempt dies first. Either way, an Approval the
 * Turn waits on is closed by `by`: the user's Stop counts as no (ADR 0024), and the user's Message
 * that interrupts it leaves it pending, since they may not have seen it yet (ADR 0030). Returns
 * whether the Turn ended here.
 */
export async function cancelTurn(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
  by: "stop" | "message",
): Promise<boolean> {
  const cancelled = await deps.runner.cancelIn(tx, turnId);
  // Cancelled first: under the job's row lock, a `waiting` row's Checkpoint either committed
  // before the close reads it, or fails its fence and rolls back.
  await closeWaitingReviews(deps, tx, { turnId }, by === "stop" ? "denied" : "pending");
  if (cancelled !== "queued") return false;
  // A queued job may have run already (handed back by a deploy, waiting out a retry, or re-queued
  // after a crash), so the Turn keeps what its Checkpoints hold. The job's row is locked, so its
  // history can't grow while it replays. It reads on `tx`, which holds those locks.
  const turn = await turnFacts(tx, turnId);
  const played = turn ? await replayedTurn(deps, tx, turn) : { transcript: [], usage: null };
  const endedAt = deps.clock();
  await endTurn(tx, turnId, {
    status: "stopped",
    error: null,
    transcript: played.transcript,
    ...changesOf(deps, turn, played.transcript),
    usage: played.usage,
    endedAt,
  });
  if (turn)
    await queueAwaySummary(deps, tx, {
      botId: turn.botId,
      conversationId: turn.conversationId,
      lastInput: played.lastInput,
      endedAt,
    });
  await turnEnded(deps, tx, turnId);
  return true;
}

/**
 * Chains the next Turn (#499), in the transaction that ended `turnId`: runs the features' `afterTurn`
 * (the memory pass, ADR 0022), and if Triggers wait in its Conversation queue, a new Turn takes all of
 * them. Returns that Turn's id, or `undefined` when the
 * queue is empty. Call the runner's `wake()` once `tx` has committed.
 */
async function turnEnded(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
): Promise<string | undefined> {
  const [ended] = await tx
    .select({ conversationId: botTurn.conversationId, botId: botTurn.botId, userId: bot.userId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  if (!ended) return undefined;
  await lockConversation(tx, ended.conversationId);
  await featuresAfterTurn(deps, tx, { id: turnId, ...ended });
  return startTurn(deps, tx, ended);
}

/** What a Turn played: its transcript and usage, and its last Step's input when known. */
type PlayedTurn = Pick<LoopResult, "transcript" | "usage"> & { lastInput?: number };

/** What a Turn's job reads once per attempt: facts set when the Turn was created. */
type TurnFacts = ContextTurn & { jobId: string | null };

async function turnFacts(
  db: Database | Transaction,
  turnId: string,
): Promise<(TurnFacts & { status: string }) | undefined> {
  const [row] = await db
    .select({
      status: botTurn.status,
      id: botTurn.id,
      botId: botTurn.botId,
      startedAt: botTurn.startedAt,
      jobId: botTurn.jobId,
      userId: bot.userId,
      conversationId: botTurn.conversationId,
      model: bot.model,
    })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  return row;
}

/**
 * Tells the Turn's Conversation it ended and, for a Room Turn, its Bot's thread too, whose log has
 * its `turn` change (`endTurn`).
 */
async function hintTurnEnded(deps: BotSdkContext, turn: { botId: string; conversationId: string }) {
  await hintChanged(deps, turn.conversationId);
  const [own] = await deps.db
    .select({ id: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, turn.botId));
  if (own && own.id !== turn.conversationId) await hintChanged(deps, own.id);
}

/**
 * One attempt of a Turn's job. It replays the Turn's recorded model calls and tool calls, makes the
 * rest for real, then ends the Turn in its last Checkpoint. An attempt that lost its job (a crash,
 * a cancel or a deploy) writes nothing more: the next attempt resumes it.
 */
async function runTurnJob(
  deps: BotSdkContext,
  turnId: string,
  ctx: WorkflowContext<Transaction> & { signal: AbortSignal },
) {
  const created = await turnFacts(deps.db, turnId);
  if (!created) throw new PermanentJobError(`Turn ${turnId} no longer exists`);
  let turn = created;
  let todo: TodoItem[] | null;
  try {
    // The to-do list as the Turn starts, recorded: every attempt reads the same.
    // Set only by a live start: a replayed one changed nothing, so hints nothing.
    let started = false;
    todo = await ctx.step(startTurnActivity, async (tx) => {
      await turnStarted(deps, tx, turnId);
      started = true;
      return todoList(tx, turn.botId);
    });
    // Read after the start: a resumed attempt replays it, so the Turn keeps the start it had.
    turn = (await turnFacts(deps.db, turnId)) ?? created;
    if (started) await hintChanged(deps, turn.conversationId);
  } catch (caught) {
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, { transcript: [], usage: null });
    throw caught;
  }
  const played = await playTurn(deps, turn, ctx, { attempt: ctx.signal, todo });
  try {
    ctx.signal.throwIfAborted();
    // A thrown activity recorded nothing: the job retries it.
    if (played.failure !== undefined) throw played.failure;
    await ctx.step("end_turn", async (tx) => {
      await lockTurnConversations(tx, turn);
      const endedAt = deps.clock();
      await endTurn(tx, turnId, {
        ...endingOf(played),
        transcript: played.transcript,
        ...changesOf(deps, turn, played.transcript),
        usage: played.usage,
        endedAt,
      });
      await queueAwaySummary(deps, tx, {
        botId: turn.botId,
        conversationId: turn.conversationId,
        lastInput: played.lastInput,
        endedAt,
      });
      await turnEnded(deps, tx, turnId);
    });
  } catch (caught) {
    // Also when the abort lands after the Turn played, before or during its end_turn Checkpoint.
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, played);
    throw caught;
  }
  deps.runner.wake();
  await hintTurnEnded(deps, turn);
}

/**
 * Ends a Turn `stopped` once its attempt has aborted, if its job was cancelled. A cancelled job
 * never reaches `onFailed`, so `bots.stop` leaves a running Turn to end here, or in `onCancelled`
 * when the attempt dies first. A lost lease or a shutdown leaves it `running`: the next attempt
 * resumes it.
 */
async function stopIfCancelled(deps: BotSdkContext, turn: TurnFacts, played: PlayedTurn) {
  const cancelled = turn.jobId && (await deps.runner.status(turn.jobId));
  if (!cancelled || cancelled.status !== "cancelled") return;
  await endRunningTurn(deps, turn, { status: "stopped", error: null }, played);
}

/**
 * The job's `onFailed`, once the runner has given up on it: ends a Turn still `running` with
 * `error` / `interrupted`, and writes the transcript and usage its recorded activities hold.
 */
async function endLostTurn(deps: BotSdkContext, turnId: string) {
  await endFromCheckpoints(deps, turnId, { status: "error", error: "interrupted" });
}

/**
 * The job's `onCancelled`, once the sweep finds a cancelled job whose attempt died before it
 * stopped the Turn: ends a Turn still `running` `stopped`, and writes the transcript and usage its
 * recorded activities hold.
 */
async function endStoppedTurn(deps: BotSdkContext, turnId: string) {
  await endFromCheckpoints(deps, turnId, { status: "stopped", error: null });
}

/** Ends a Turn still `running` as `ending` says, with what its recorded Checkpoints hold. */
async function endFromCheckpoints(
  deps: BotSdkContext,
  turnId: string,
  ending: { status: TurnStatus; error: string | null },
) {
  const turn = await turnFacts(deps.db, turnId);
  // A Turn that has already ended stays as it is, so there is nothing to replay.
  if (turn?.status !== "running") return;
  let played: PlayedTurn = { transcript: [], usage: null };
  try {
    played = await replayedTurn(deps, deps.db, turn);
  } catch (caught) {
    // The Turn still ends, so it never reads `running` forever; only its transcript is lost.
    deps.logger.error(`Replaying the Checkpoints of Turn ${turnId} failed`, caught);
  }
  await endRunningTurn(deps, turn, ending, played);
}

/**
 * Ends a Turn still `running` as `ending` says, with `played`'s transcript and usage, from outside
 * its job, and starts the next Turn for what waits in the Conversation queue, under the
 * Conversation's row lock. A Turn that has already ended stays as it is.
 */
async function endRunningTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
  ending: { status: TurnStatus; error: string | null },
  played: PlayedTurn,
) {
  const ended = await deps.db.transaction(async (tx) => {
    await lockTurnConversations(tx, turn);
    const endedAt = deps.clock();
    const rows = await tx
      .update(botTurn)
      .set({
        ...ending,
        transcript: played.transcript,
        ...changesOf(deps, turn, played.transcript),
        usage: played.usage,
        endedAt,
      })
      .where(and(eq(botTurn.id, turn.id), eq(botTurn.status, "running")))
      .returning({ id: botTurn.id });
    if (rows.length === 0) return false;
    await recordBotChange(tx, turn, "turn", turn.id, endedAt);
    // A Turn cut off mid-wait (its time limit) leaves no request open.
    await closeWaitingReviews(deps, tx, { turnId: turn.id }, "expired");
    await queueAwaySummary(deps, tx, {
      botId: turn.botId,
      conversationId: turn.conversationId,
      lastInput: played.lastInput,
      endedAt,
    });
    await turnEnded(deps, tx, turn.id);
    return true;
  });
  if (ended) deps.runner.wake();
  await hintTurnEnded(deps, turn);
}

/**
 * What a Turn whose job has ended did: its recorded calls replay, and the first one past them
 * stops the Turn there. Its transcript and usage are those of the recorded calls.
 */
async function replayedTurn(
  deps: BotSdkContext,
  db: Database | Transaction,
  turn: TurnFacts,
): Promise<PlayedTurn> {
  const history = turn.jobId ? await loadHistory(db, turn.jobId) : [];
  const ended = AbortSignal.abort(new Error("The Turn's job has ended"));
  const workflow = createWorkflow<Transaction>({
    history,
    store: {
      save: async () => false,
      saveWith: async () => ({ saved: false }),
    },
    now: deps.clock,
    signal: ended,
  });
  try {
    // A job that never started recorded no start.
    const todo =
      history.length > 0
        ? await workflow.context.step<TodoItem[] | null>(startTurnActivity, async () => null)
        : null;
    return await playTurn(deps, turn, workflow.context, { db, todo });
  } catch (caught) {
    // The job ended before it stored the Turn's input, so the Turn sent nothing.
    if (caught === ended.reason) return { transcript: [], usage: null };
    throw caught;
  }
}

/**
 * What the enabled features say a Turn's `transcript` changed, for its chips (#919): none
 * without a Turn.
 */
function changesOf(
  deps: BotSdkContext,
  turn: ContextTurn | undefined,
  transcript: readonly ModelMessage[],
): TurnChanges {
  return turn
    ? featureTurnChanges(deps, { ...featureTurnOf(turn), transcript })
    : { skillChanges: null, knowledgeChanges: null };
}

/** Ends the Turn's row, with its `turn` change, in its last Checkpoint's transaction. */
async function endTurn(
  tx: Transaction,
  turnId: string,
  ending: TurnChanges & {
    status: TurnStatus;
    error: string | null;
    transcript: ModelMessage[];
    usage: MessageUsage | null;
    endedAt: Date;
  },
) {
  const [ended] = await tx
    .update(botTurn)
    .set(ending)
    .where(eq(botTurn.id, turnId))
    .returning({ conversationId: botTurn.conversationId, botId: botTurn.botId });
  if (!ended) return;
  // A Room Turn's end is the Room's change (spec #1055), and a hint to its Bot's thread too: its
  // Tasks view reads its running Turn in any Conversation.
  await recordBotChange(
    tx,
    { conversationId: ended.conversationId },
    "turn",
    turnId,
    ending.endedAt,
  );
  const [own] = await tx
    .select({ id: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, ended.botId));
  if (own && own.id !== ended.conversationId)
    await recordBotChange(tx, { conversationId: own.id }, "turn", turnId, ending.endedAt);
}

/**
 * The Turn's loop (slide 2), run through `runLoop`: SendToUser, the Routine and Check-in tools and,
 * whenever the computer slot is set, the Computer's tools and `start_helper`. A SendToUser's Message commits with its
 * Checkpoint, so it is sent once. A Step with no tool call ends the Turn quiet, except that the
 * first one with plain text gets one more Step, after `undeliveredTextReminder`, when a Step is left
 * under the limit; the Step and time limits end it `error`.
 *
 * `attempt`, when given, is the attempt's signal: the live call stops when it aborts. `db` reads the
 * Turn's input (`deps.db` unless given).
 */
async function playTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
  ctx: WorkflowContext<Transaction>,
  {
    attempt,
    db = deps.db,
    todo,
  }: { attempt?: AbortSignal; db?: Database | Transaction; todo: TodoItem[] | null },
): Promise<LoopResult> {
  // Asked once for the newest message and the loop's model calls.
  const canSee = seesImagesOnce(deps, turn);
  // The newest message holds the Change notes, which are read in the loop's setup: it is rendered
  // there, once the Turn's Prompt start is chosen.
  const newest = await newestRenderer(deps, turn, ctx, { db, todo, attempt, canSee });
  // The features' tools' clients (the Connector tools') stay open for the Turn's loop, and close when it ends.
  const connections = new AbortController();
  try {
    return await runLoop(deps, ctx, {
      owner: turn,
      usageKind: "turn",
      sourceId: turn.id,
      // The history and the newest message come from the setup, once the Prompt start is chosen.
      input: [],
      startedAt: turn.startedAt,
      stepLimit: turnStepLimit,
      timeLimitMs: turnTimeLimitMs,
      plainTextReminder: undeliveredTextReminder,
      attempt,
      seesImages: canSee,
      // Each shell call of the Turn gets Auto-review before it runs (spec #691).
      review: { turnId: turn.id, conversationId: turn.conversationId },
      db,
      setup: async (kit) => {
        // The Turn's context and its tool catalogue, read once as it starts (spec #871).
        const context = await build(deps, turn, {
          ...recordedReads(deps, turn, kit),
          tools: (sections) =>
            forTurn(deps, turn, sections, {
              kit,
              signal: connections.signal,
              record: (featureId, list) => ctx.step(`${featureId}:tools`, list),
            }),
        });
        const start = await context.start(kit, { db, newest });
        const { tools, searchTools, ended } = context.tools;
        return {
          promptStart: start.promptStart,
          history: start.history,
          summarize: start.summarize,
          tools: [...[...tools, ...searchTools].map(checkedTool), ...start.retired],
          ended,
          newest: start.newest,
        };
      },
    });
  } finally {
    connections.abort();
  }
}

/** How a Turn ended, and why when it failed: a limit's code or the Provider's error. */
function endingOf({
  timedOut,
  stepLimit,
  stopped,
  error,
  finished,
}: Pick<LoopResult, "timedOut" | "stepLimit" | "stopped" | "error" | "finished">): {
  status: TurnStatus;
  error: string | null;
} {
  if (timedOut) return { status: "error", error: "timed_out" };
  if (stopped) return { status: "stopped", error: null };
  if (error !== undefined) return { status: "error", error };
  if (stepLimit) return { status: "error", error: "step_limit" };
  return finished ? { status: "complete", error: null } : { status: "stopped", error: null };
}
