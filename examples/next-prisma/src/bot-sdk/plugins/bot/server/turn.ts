import {
  type AnyTextAdapter,
  type ChatMiddlewareContext,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
  toolDefinition,
} from "@tanstack/ai";
import { and, asc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botTrigger, botTurn, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { rpcError } from "../../../core/server/rpc-error";
import { searchTextOf } from "../../../core/shared/message-parts";
import { conversationChannel } from "../../assistant/server/memory/notice";
import { addUsage, promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import { parseModelId } from "../../models/shared/models";
import type { MessageUsage } from "../../models/shared/usage";
import {
  type ComputerHandle,
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../computer/server/plugin";
import { defineJob, PermanentJobError } from "../../runner/server/jobs/define";
import { loadHistory } from "../../runner/server/jobs/history";
import {
  createWorkflow,
  type WorkflowContext,
  WorkflowYieldedError,
} from "../../runner/server/workflow/engine";
import type { BotMessage, BotSendEvent, TurnStatus } from "../shared/turn";
import {
  botTurnJobName,
  lockConversation,
  receive,
  turnEnded,
  turnStarted,
  waitingIn,
} from "./router";
import {
  capOutput,
  computerOf,
  computerPrompt,
  computerOperationError,
  computerUnavailableError,
  defaultShellTimeoutSeconds,
  editDefinition,
  editTool,
  interruptedShellError,
  listDefinition,
  listTool,
  readDefinition,
  readTool,
  rebuiltNote,
  resolvePath,
  shellDefinition,
  shellStartActivity,
  shellToolName,
  spillPath,
  timedOutHint,
  writeDefinition,
  writeTool,
} from "./computer-tools";
import {
  botMessages,
  computerRebuildSeenAt,
  findBot,
  markComputerRebuildSeen,
  textParts,
  toBotMessage,
  turnTimeLimitMs,
} from "./store";

/** The most Steps a Turn may take; one more ends it `error` with `step_limit`. */
export const turnStepLimit = 10;

/** The Bot's one tool in step 1: the only way it reaches the user. */
export const sendToUserToolName = "send_to_user";

const promptOpening =
  "You are a Bot the user talks to in a messenger. The user never sees your text replies or your " +
  `tool calls; they see only the messages you send with the ${sendToUserToolName} tool. `;

/** What the Bot can't do, with no Computer. */
const onlyToolLimits =
  "It is your only tool: you cannot send email or messages to anyone else, look up live data, or act " +
  "outside this chat. ";

/** What the Bot can't do, with its Computer. */
const computerLimits =
  "Besides it, you have only your computer (below): you cannot send email or messages to anyone " +
  "else. ";

const promptRules =
  "When asked to, say plainly that you cannot, then offer what you can do. To say " +
  `something, call ${sendToUserToolName}. You may call it more than once, in order. Set endTurn to ` +
  "true on your last message, so you stop there. Anything you want the user to read goes through " +
  "it, including a refusal (you cannot do what they asked) and a question you need answered. If " +
  "there is nothing worth saying (the user just acknowledged, said goodbye for now, or needs no " +
  "answer), send nothing: reply with no text and no tool call, not even to say you are staying " +
  "quiet. Do not send a pleasantry (you're welcome, good luck, see you) in reply to one.";

/** The fixed Bot system prompt with no Computer: there are no per-Bot instructions. */
export const botSystemPrompt = promptOpening + onlyToolLimits + promptRules;

/**
 * The system prompts of a Bot's Turn. With `computer` on, the Bot's limits allow its Computer, and
 * a second prompt names its own directory and the shared one; with it off, it is `botSystemPrompt`.
 */
export function botSystemPrompts(botId: string, withComputer: boolean): string[] {
  if (!withComputer) return [botSystemPrompt];
  return [promptOpening + computerLimits + promptRules, computerPrompt(botId)];
}

/** What SendToUser returns for an empty `text`: what went wrong, and what to do instead. */
export const emptyTextError =
  `The message was not sent: text is empty. Call ${sendToUserToolName} again with the words the ` +
  "user should read, or, if there is nothing worth saying, reply with no text and no tool call.";

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

/** How often `bot.send` re-reads its Turn when no hint has come (#483). */
export const followPollMs = 2_000;

const sendToUserDefinition = toolDefinition({
  name: sendToUserToolName,
  description:
    "Send one message to the user. This is the only way the user sees anything from you: your " +
    "plain text replies stay private. Each call appears to the user at once as its own message, " +
    "in the order you call it. Set endTurn to true on your last message of this turn, so the " +
    "turn ends there; set it to false when you will send more.",
  inputSchema: z.object({
    text: z.string().meta({ description: "The message the user reads, as plain text." }),
    endTurn: z.boolean().meta({
      description: "true on your last message of this turn, false when you will send more.",
    }),
  }),
});

/**
 * Tells whoever follows the Conversation that it changed, so they re-read it from Postgres. Never
 * throws: a lost hint is covered by the follower's re-read every `followPollMs`.
 */
async function hintChanged(deps: BotSdkContext, conversationId: string) {
  try {
    await deps.pubsub.publish(
      conversationChannel(conversationId),
      JSON.stringify({ type: "changed" }),
    );
  } catch (caught) {
    deps.logger.error(`Publishing a change of Conversation ${conversationId} failed`, caught);
  }
}

/** The runner job of one Turn, keyed by the Turn's id (ADR 0011, the #482 amendment). */
export const botTurnJob = defineJob({
  name: botTurnJobName,
  payload: z.object({ turnId: z.uuid() }),
  run: ({ turnId }, ctx) => runTurnJob(ctx.deps, turnId, ctx),
  onFailed: ({ turnId }, _error, deps) => endLostTurn(deps, turnId),
  onCancelled: ({ turnId }, deps) => endStoppedTurn(deps, turnId),
});

/**
 * Saves the user's Message and hands its Trigger to the Router, in one transaction: a Turn takes it
 * now or, while a Turn's job runs, that Turn is interrupted and the next one does. Checks run
 * before anything is written, and a refusal throws an RPC error before the stream starts. The
 * returned stream follows the Turn that takes the Message from Postgres: the saved user Message,
 * each Message sent after it, then `turnEnded`. Leaving it ends only the follow, never the Turn.
 */
export async function sendToBot(
  deps: BotSdkContext,
  {
    userId,
    botId,
    id,
    text,
    signal,
  }: { userId: string; botId: string; id: string; text: string; signal?: AbortSignal },
): Promise<AsyncGenerator<BotSendEvent>> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const call = await deps.plugin("models").resolveModelCall(userId, found.model);
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
    // A Turn on Host credentials is refused once its Quota's window has spent the budget (ADR 0007),
    // before the user's Message is saved. It is checked here only, so a resumed Turn is never refused.
    if (!(await call.meter.mayRun()).ok) {
      throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
    }
    // Read under the lock, so no Turn starts between this time and the Message's commit.
    const now = deps.clock();
    const row = await appendMessage(tx, found.conversationId, {
      id,
      role: "user",
      parts: textParts(text),
      status: "complete",
      createdAt: now,
    });
    const { waitsFor } = await receive(deps, tx, {
      id: row.id,
      conversationId: found.conversationId,
      source: "user",
      channel: "web",
      messageId: row.id,
      receivedAt: now,
    });
    // The owner skips the line (#500): a Message sent while a Turn's job runs interrupts that Turn,
    // and the Turn that follows it takes the Message.
    const ended = waitsFor ? await cancelTurn(deps, tx, waitsFor) : false;
    return { userMessage: toBotMessage(row), started: true, ended };
  });
  if (sent.started) deps.plugin("runner").wake();
  if (sent.ended) await hintChanged(deps, found.conversationId);

  return followTurn(deps, {
    conversationId: found.conversationId,
    triggerId: sent.userMessage.id,
    userMessage: sent.userMessage,
    signal,
  });
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
 * reads them as history. Does nothing when no Turn is running.
 */
export async function stopBot(deps: BotSdkContext, userId: string, botId: string): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const ended = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in `sendToBot`.
    await lockConversation(tx, found.conversationId);
    const running = await runningTurnOf(tx, botId);
    if (!running) return false;
    await tx.update(botTrigger).set({ turnId: running }).where(waitingIn(found.conversationId));
    return cancelTurn(deps, tx, running);
  });
  if (!ended) return;
  deps.plugin("runner").wake();
  await hintChanged(deps, found.conversationId);
}

/** The id of the Bot's running Turn, or `undefined` when none runs. */
async function runningTurnOf(tx: Transaction, botId: string): Promise<string | undefined> {
  const [running] = await tx
    .select({ id: botTurn.id })
    .from(botTurn)
    .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")))
    .limit(1);
  return running?.id;
}

/**
 * Cancels Turn `turnId`'s job, unless it is already cancelled, under the Conversation's row lock
 * (#500). A queued job never runs again, so its Turn ends `stopped` here and the next Turn takes
 * what waits in the Conversation queue; a running one ends `stopped` as its attempt aborts
 * (`runTurnJob`), or in `onCancelled` when that attempt dies first. Returns whether the Turn ended
 * here.
 */
async function cancelTurn(deps: BotSdkContext, tx: Transaction, turnId: string): Promise<boolean> {
  if ((await deps.plugin("runner").cancelIn(tx, turnId)) !== "queued") return false;
  // A queued job may have run already (handed back by a deploy, waiting out a retry, or re-queued
  // after a crash), so the Turn keeps what its Checkpoints hold. The job's row is locked, so its
  // history can't grow while it replays. It reads on `tx`, which holds those locks.
  const turn = await turnFacts(tx, turnId);
  const played = turn ? await replayedTurn(deps, tx, turn) : { transcript: [], usage: null };
  await endTurn(tx, turnId, {
    status: "stopped",
    error: null,
    transcript: played.transcript,
    usage: played.usage,
    endedAt: deps.clock(),
  });
  await turnEnded(deps, tx, turnId);
  return true;
}

/**
 * Follows the Turn that takes a Trigger, from Postgres (#483, slide 19's "signal, then fetch"):
 * yields the user Message, then re-reads on each "changed" hint on the Conversation's channel, and
 * every `followPollMs` in case a hint is lost, yielding each new Message, until a Turn has taken
 * the Trigger and ended.
 */
async function* followTurn(
  deps: BotSdkContext,
  {
    conversationId,
    triggerId,
    userMessage,
    signal,
  }: { conversationId: string; triggerId: string; userMessage: BotMessage; signal?: AbortSignal },
): AsyncGenerator<BotSendEvent> {
  yield { type: "message", message: userMessage };
  let hinted = false;
  let wake = () => {};
  const unsubscribe = await deps.pubsub.subscribe(conversationChannel(conversationId), () => {
    hinted = true;
    wake();
  });
  const onAbort = () => wake();
  signal?.addEventListener("abort", onAbort, { once: true });
  const shown = new Set([userMessage.id]);
  try {
    while (!signal?.aborted) {
      hinted = false;
      // The status first: the Messages read after it hold every one sent before the Turn ended.
      // A Trigger no Turn has taken yet has no status: it waits in the Conversation queue.
      const [taken] = await deps.db
        .select({ status: botTurn.status })
        .from(botTrigger)
        .leftJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
        .where(eq(botTrigger.id, triggerId));
      for (const sent of await botMessages(deps.db, conversationId, userMessage.createdAt)) {
        if (shown.has(sent.id)) continue;
        shown.add(sent.id);
        yield { type: "message", message: sent };
      }
      if (!taken) {
        yield { type: "turnEnded", status: "error" };
        return;
      }
      if (taken.status !== null && taken.status !== "running") {
        yield { type: "turnEnded", status: taken.status };
        return;
      }
      await new Promise<void>((resolve) => {
        if (hinted || signal?.aborted) return resolve();
        const timer = setTimeout(resolve, followPollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await unsubscribe();
  }
}

/** What a Turn's job reads once per attempt: facts set when the Turn was created. */
type TurnFacts = {
  id: string;
  botId: string;
  userId: string;
  conversationId: string;
  model: string;
  startedAt: Date;
  jobId: string | null;
};

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
      conversationId: bot.conversationId,
      model: bot.model,
    })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  return row;
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
  try {
    await ctx.activity(startTurnActivity, async (tx) => {
      await turnStarted(deps, tx, turnId);
      return null;
    });
    // Read after the start: a resumed attempt replays it, so the Turn keeps the start it had.
    turn = (await turnFacts(deps.db, turnId)) ?? created;
  } catch (caught) {
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, { transcript: [], usage: null });
    throw caught;
  }
  const played = await playTurn(deps, turn, ctx, { attempt: ctx.signal });
  try {
    ctx.signal.throwIfAborted();
    // A thrown activity recorded nothing: the job retries it.
    if (played.failure !== undefined) throw played.failure;
    await ctx.activity("end_turn", async (tx) => {
      await lockConversation(tx, turn.conversationId);
      await endTurn(tx, turnId, {
        ...endingOf(played),
        transcript: played.transcript,
        usage: played.usage,
        endedAt: deps.clock(),
      });
      await turnEnded(deps, tx, turnId);
    });
  } catch (caught) {
    // Also when the abort lands after the Turn played, before or during its end_turn Checkpoint.
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, played);
    throw caught;
  }
  deps.plugin("runner").wake();
  await hintChanged(deps, turn.conversationId);
}

/**
 * Ends a Turn `stopped` once its attempt has aborted, if its job was cancelled. A cancelled job
 * never reaches `onFailed`, so `bot.stop` leaves a running Turn to end here, or in `onCancelled`
 * when the attempt dies first. A lost lease or a shutdown leaves it `running`: the next attempt
 * resumes it.
 */
async function stopIfCancelled(
  deps: BotSdkContext,
  turn: TurnFacts,
  played: Pick<PlayedTurn, "transcript" | "usage">,
) {
  const cancelled = turn.jobId && (await deps.plugin("runner").status(turn.jobId));
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
  let played: Pick<PlayedTurn, "transcript" | "usage"> = { transcript: [], usage: null };
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
  played: Pick<PlayedTurn, "transcript" | "usage">,
) {
  const ended = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, turn.conversationId);
    const rows = await tx
      .update(botTurn)
      .set({ ...ending, transcript: played.transcript, usage: played.usage, endedAt: deps.clock() })
      .where(and(eq(botTurn.id, turn.id), eq(botTurn.status, "running")))
      .returning({ id: botTurn.id });
    if (rows.length === 0) return false;
    await turnEnded(deps, tx, turn.id);
    return true;
  });
  if (ended) deps.plugin("runner").wake();
  await hintChanged(deps, turn.conversationId);
}

/**
 * What a Turn whose job has ended did: its recorded calls replay, and the first one past them
 * stops the Turn there. Its transcript and usage are those of the recorded calls.
 */
async function replayedTurn(
  deps: BotSdkContext,
  db: Database | Transaction,
  turn: TurnFacts,
): Promise<Pick<PlayedTurn, "transcript" | "usage">> {
  const history = turn.jobId ? await loadHistory(db, turn.jobId) : [];
  const workflow = createWorkflow<Transaction>({
    history,
    store: {
      save: async () => false,
      saveWith: async () => ({ saved: false }),
    },
    now: deps.clock,
    signal: AbortSignal.abort(new Error("The Turn's job has ended")),
  });
  // A job that never started recorded no start.
  if (history.length > 0) await workflow.context.activity(startTurnActivity, async () => null);
  return playTurn(deps, turn, workflow.context, { db });
}

/** Ends the Turn's row, in its last Checkpoint's transaction. */
async function endTurn(
  tx: Transaction,
  turnId: string,
  ending: {
    status: TurnStatus;
    error: string | null;
    transcript: ModelMessage[];
    usage: MessageUsage | null;
    endedAt: Date;
  },
) {
  await tx.update(botTurn).set(ending).where(eq(botTurn.id, turnId));
}

/**
 * The Turn's model input: each user Message as a user turn and each earlier Turn as its transcript,
 * in order. The Bot's sent Messages are not replayed as text: the transcripts hold them as
 * SendToUser calls. Only what came before the Turn counts, so every attempt reads the same input.
 */
async function modelInput(db: Database | Transaction, turn: TurnFacts): Promise<ModelMessage[]> {
  const [users, turns] = await Promise.all([
    db
      .select({ parts: message.parts, createdAt: message.createdAt })
      .from(message)
      .where(
        and(
          eq(message.conversationId, turn.conversationId),
          eq(message.role, "user"),
          lt(message.createdAt, turn.startedAt),
        ),
      )
      .orderBy(asc(message.createdAt), asc(message.id)),
    db
      .select({ transcript: botTurn.transcript, startedAt: botTurn.startedAt })
      .from(botTurn)
      .where(and(eq(botTurn.botId, turn.botId), lt(botTurn.startedAt, turn.startedAt)))
      .orderBy(asc(botTurn.startedAt), asc(botTurn.id)),
  ]);
  const entries = [
    ...users.map((row) => ({
      at: row.createdAt.getTime(),
      messages: [{ role: "user" as const, content: searchTextOf(row.parts) }],
    })),
    ...turns.map((row) => ({ at: row.startedAt.getTime(), messages: row.transcript ?? [] })),
  ];
  // A stable sort keeps a user Message before a Turn that started at the same time.
  entries.sort((a, b) => a.at - b.at);
  return entries.flatMap((entry) => entry.messages);
}

/** What one model call recorded: its chunks, and what it bills (`null` for nothing). */
type RecordedModelCall = {
  chunks: StreamChunk[];
  usage: { usage: MessageUsage; reportedCost?: number } | null;
};

/** The Model's own failure in a live model call, as opposed to a failure to save its Checkpoint. */
class ModelCallError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** What a played Turn came to. `failure` is an activity that threw, which recorded nothing. */
type PlayedTurn = {
  timedOut: boolean;
  stepLimit: boolean;
  stopped: boolean;
  error: string | undefined;
  finished: boolean;
  transcript: ModelMessage[];
  usage: MessageUsage | null;
  failure?: unknown;
};

/**
 * The Turn's loop (slide 2): `chat()` with SendToUser as its only tool, each model call and each
 * tool call an activity of the workflow `ctx` (ADR 0011, the #482 amendment). A recorded call
 * returns its result without running; past the history, calls run for real. A model call's usage
 * and a SendToUser's Message commit with their Checkpoint, so each happens once. A Step with no
 * tool call ends the Turn quiet, except that the first one with plain text gets one more Step,
 * after `undeliveredTextReminder`, when a Step is left under the limit; the Step and time limits
 * end it `error`.
 *
 * `attempt`, when given, is the attempt's signal: the live call stops when it aborts. `db` reads the
 * Turn's input (`deps.db` unless given).
 */
async function playTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
  ctx: WorkflowContext<Transaction>,
  { attempt, db = deps.db }: { attempt?: AbortSignal; db?: Database | Transaction },
): Promise<PlayedTurn> {
  const input = await modelInput(db, turn);
  const provider = parseModelId(turn.model)?.provider ?? "";
  const abortController = new AbortController();
  const onAttemptAbort = () => abortController.abort(attempt?.reason);
  if (attempt?.aborted) onAttemptAbort();
  attempt?.addEventListener("abort", onAttemptAbort, { once: true });
  let timedOut = false;
  const timeUp = () => {
    // A Turn that was stopped but hasn't ended yet stays stopped.
    if (abortController.signal.aborted) return;
    timedOut = true;
    abortController.abort();
  };
  // Wall clock from the Turn's start. It cuts off only a live model call, never the replay of the
  // recorded ones: past the limit, the next live call ends the Turn. A replay with no attempt (the
  // job's `onFailed`) has no limit.
  let expired = false;
  let inLiveCall = false;
  const timeLeftMs = () => turnTimeLimitMs - (deps.clock().getTime() - turn.startedAt.getTime());
  const timeLimit = attempt
    ? setTimeout(
        () => {
          expired = true;
          if (inLiveCall) timeUp();
        },
        Math.max(0, timeLeftMs()),
      )
    : undefined;
  let endTurn = false;
  let stepLimit = false;
  /** The Turn's Steps so far, recorded or live: one per model call. */
  let steps = 0;
  /** What each recorded model call billed. */
  const billed: MessageUsage[] = [];
  /** The tool calls whose activity threw: they recorded nothing, so they stay unanswered. */
  const unanswered = new Set<string>();
  let failure: unknown;
  let error: string | undefined;
  let finished = false;

  /** The Model's call, made once: the credentials and the adapter are only needed for a live call. */
  let live: Promise<{ adapter: AnyTextAdapter; record: ModelCallRecorder }> | undefined;
  const liveCall = () =>
    (live ??= (async () => {
      const models = deps.plugin("models");
      const call = await models.resolveModelCall(turn.userId, turn.model);
      if (!call) throw new Error(`"${turn.model}" is not an available Model`);
      return {
        adapter: models.adapterFor(turn.model, call.credentials, {
          maxOutputTokens: call.maxOutputTokens,
        }),
        record: (tx, usage, reportedCost) =>
          call.meter.recordIn(tx, { kind: "turn", usage, reportedCost }),
      };
    })());

  // The model call as an activity: replayed, it plays the recorded chunks without calling the Model.
  // The call runs outside a transaction; its bill is the next activity, written in that activity's
  // Checkpoint transaction, so it commits once.
  const durableAdapter = {
    kind: "text",
    name: provider,
    model: parseModelId(turn.model)?.modelId ?? turn.model,
    chatStream: async function* (options: TextOptions) {
      steps += 1;
      let recorded: RecordedModelCall;
      try {
        recorded = await ctx.activity("model", async (): Promise<RecordedModelCall> => {
          // Read off the clock too: a timer that is due may not have fired yet.
          if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
          abortController.signal.throwIfAborted();
          const chunks: StreamChunk[] = [];
          inLiveCall = true;
          try {
            const { adapter } = await liveCall();
            for await (const chunk of adapter.chatStream(options)) chunks.push(withoutRaw(chunk));
          } catch (caught) {
            throw new ModelCallError(caught);
          } finally {
            inLiveCall = false;
          }
          // A call cut off before its end records nothing and bills nothing; a resume calls it again.
          abortController.signal.throwIfAborted();
          const usage = callUsage(deps, provider, chunks, options.messages as ModelMessage[]);
          return { chunks, usage: usage ?? null };
        });
        const bill = recorded.usage;
        if (bill) {
          let fire: (() => void) | undefined;
          try {
            await ctx.activity("bill", async (tx) => {
              const { record } = await liveCall();
              fire = await record(tx, bill.usage, bill.reportedCost);
              return null;
            });
          } catch (caught) {
            // A yield is thrown once the bill's Checkpoint has committed: its next attempt replays
            // the bill, so it fires now or never.
            if (caught instanceof WorkflowYieldedError) fire?.();
            throw caught;
          }
          // Only once the bill has committed, and never on a replay.
          fire?.();
          billed.push(bill.usage);
        }
      } catch (caught) {
        // The Model's own failure ends the Turn `error`, as `chat()` reports it.
        if (caught instanceof ModelCallError) throw caught.cause;
        // Anything else (a Checkpoint or a bill that failed to save) recorded nothing: the job
        // retries it.
        if (!abortController.signal.aborted) {
          failure ??= caught;
          abortController.abort();
        }
        throw caught;
      }
      yield* recorded.chunks;
    },
  } as unknown as AnyTextAdapter;

  /**
   * One tool call. A call that throws recorded nothing: it stays unanswered and ends the attempt,
   * and only a throw that no time limit or stop caused is a failure to retry.
   */
  const toolCallOf = async <T>(toolCallId: string | undefined, call: () => Promise<T>) => {
    try {
      return await call();
    } catch (caught) {
      if (!abortController.signal.aborted) failure ??= caught;
      if (toolCallId) unanswered.add(toolCallId);
      abortController.abort();
      throw caught;
    }
  };
  /**
   * Called first in a tool's activity, which runs only live, so a recorded call still replays:
   * past the limit, a resumed Turn does nothing more, and never answers a question from long ago.
   */
  const beforeLiveTool = () => {
    if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
    abortController.signal.throwIfAborted();
  };

  const sendToUser = sendToUserDefinition.server(({ text, endTurn: last }, context) =>
    toolCallOf(context?.toolCallId, async () => {
      // The Message commits with its Checkpoint, so it is sent once across a crash.
      const result = await ctx.activity(sendToUserToolName, async (tx) => {
        beforeLiveTool();
        if (!text.trim()) return { error: emptyTextError };
        await appendMessage(tx, turn.conversationId, {
          role: "assistant",
          parts: textParts(text),
          status: "complete",
          createdAt: deps.clock(),
        });
        return { sent: true };
      });
      if ("sent" in result) {
        if (last) endTurn = true;
        await hintChanged(deps, turn.conversationId);
      }
      return result;
    }),
  );

  // The Computer's tools, whenever `computer` is on: the tool set never changes mid-conversation.
  const withComputer = deps.hasPlugin("computer");
  let userComputer: ComputerHandle | undefined;
  // The latest rebuild of the Computer the Bot was told of, read on its first Computer call
  // (undefined until then), and the one the latest result tells, recorded once it is saved.
  let rebuildSeenAt: Date | null | undefined;
  let telling: Date | undefined;
  /**
   * The Computer's operation for a live tool call. A failed wake, or an operation the provider
   * failed, is the tool's result, unless the Turn was stopped or ran out of time meanwhile: then
   * the call stays unanswered. A database failure throws, so the Turn's job retries it. After a
   * rebuild the Bot wasn't told of, the result carries the rebuilt note (#553).
   */
  const onComputer = async <T extends object>(
    operate: (computer: ComputerHandle) => Promise<T>,
  ) => {
    const computer = (userComputer ??= computerOf(deps, turn.userId));
    try {
      const result = await operate(computer);
      const rebuild = computer.rebuild();
      if (!rebuild) return result;
      if (rebuildSeenAt === undefined)
        rebuildSeenAt = await computerRebuildSeenAt(deps.db, turn.botId);
      if (rebuildSeenAt && rebuild.rebuiltAt <= rebuildSeenAt) return result;
      telling = rebuild.rebuiltAt;
      return { ...result, note: rebuiltNote(rebuild) };
    } catch (caught) {
      if (!abortController.signal.aborted) {
        if (caught instanceof ComputerUnavailableError) return { error: computerUnavailableError };
        if (caught instanceof ComputerOperationError) {
          return { error: computerOperationError(caught.message) };
        }
      }
      throw caught;
    }
  };
  /**
   * After a Computer tool's Checkpoint is saved: the rebuild its result told is recorded as told.
   * A crash before then tells it again in the retried attempt rather than never.
   */
  const recordTold = async <T>(result: T): Promise<T> => {
    if (telling) {
      await markComputerRebuildSeen(deps.db, turn.botId, telling);
      rebuildSeenAt = telling;
      telling = undefined;
    }
    return result;
  };
  const shell = shellDefinition.server(({ command, cwd, timeoutSeconds }, context) =>
    toolCallOf(context?.toolCallId, async () => {
      // The start marker: a resumed Turn that replays it with no result never runs the command
      // again, since it may have partly run. A yield waits for the command's own Checkpoint, so
      // the marker never stands for a command that didn't start. No transaction: the command runs
      // on the Computer, not in the database.
      let startedHere = false;
      await ctx.activity(
        shellStartActivity,
        async () => {
          beforeLiveTool();
          startedHere = true;
          return null;
        },
        { yields: false },
      );
      const result = await ctx.activity(shellToolName, async () => {
        beforeLiveTool();
        if (!startedHere) return { error: interruptedShellError };
        // A live call: the Turn's time limit, like a Stop, kills the command through the signal.
        inLiveCall = true;
        try {
          return await onComputer(async (computer) => {
            const result = await computer.run(command, {
              cwd: resolvePath(turn.botId, cwd),
              timeoutMs: (timeoutSeconds ?? defaultShellTimeoutSeconds) * 1000,
              deadline: new Date(turn.startedAt.getTime() + turnTimeLimitMs),
              signal: abortController.signal,
            });
            // The cap is applied here, so the Checkpoint holds only the truncated form.
            const capped = await capOutput(
              result,
              spillPath(turn.botId, context?.toolCallId ?? uuidv7()),
              computer.writeFile,
            );
            return "timedOut" in capped ? { ...capped, hint: timedOutHint } : capped;
          });
        } finally {
          inLiveCall = false;
        }
      });
      return recordTold(result);
    }),
  );
  /** A file tool: one activity, re-run after a crash. */
  const fileTool =
    <Input, Output extends object>(
      name: string,
      run: (computer: ComputerHandle, botId: string, input: Input) => Promise<Output>,
    ) =>
    (input: Input, context?: { toolCallId?: string }) =>
      toolCallOf(context?.toolCallId, async () =>
        recordTold(
          await ctx.activity(name, async () => {
            beforeLiveTool();
            return onComputer((computer) => run(computer, turn.botId, input));
          }),
        ),
      );
  const read = readDefinition.server(fileTool("read", readTool));
  const write = writeDefinition.server(fileTool("write", writeTool));
  const edit = editDefinition.server(fileTool("edit", editTool));
  const list = listDefinition.server(fileTool("list", listTool));

  /** What the Turn's model calls and tool calls added to its input, in order. */
  const messages: ModelMessage[] = [];
  try {
    let reminded = false;
    for (;;) {
      let engine: ChatMiddlewareContext | undefined;
      const stream = chat({
        adapter: durableAdapter,
        messages: [...input, ...messages],
        systemPrompts: botSystemPrompts(turn.botId, withComputer),
        tools: withComputer ? [sendToUser, shell, read, write, edit, list] : [sendToUser],
        // One call at a time, in call order, which is a workflow's identity.
        toolExecution: "sequential",
        abortController,
        // The Step limit is the middleware's, so the engine's default limit doesn't end the Turn first.
        agentLoopStrategy: () => true,
        middleware: [
          {
            name: "bot-turn",
            onStart: (middlewareCtx) => {
              engine = middlewareCtx;
            },
            onShouldContinue: (_middlewareCtx, state) => {
              // Any `endTurn: true` in the Step ends the Turn with no further model call.
              if (endTurn) return false;
              // A Step that called a tool would go on to another; past the limit, the Turn ends.
              // Replay counts the recorded Steps, so a crash can't reset the limit.
              if (state.lastTurnToolCallCount > 0 && steps >= turnStepLimit) {
                stepLimit = true;
                return false;
              }
              return true;
            },
          },
        ],
      });
      try {
        for await (const chunk of stream) {
          if (chunk.type === EventType.RUN_ERROR) error = chunk.message;
        }
      } finally {
        if (engine) messages.push(...engine.messages.slice(engine.messageCount));
      }
      if (reminded || endTurn || stepLimit || error !== undefined) break;
      // With no Step left under the limit, there is no reminder: the Turn ends quiet, as before.
      if (abortController.signal.aborted || steps >= turnStepLimit) break;
      if (!endsInPlainText(messages)) break;
      // Plain text reaches no one: one more Step, with a note that says so (#531). It is rebuilt
      // from the recorded model call on replay, so it needs no Checkpoint of its own.
      reminded = true;
      messages.push({ role: "user", content: undeliveredTextReminder });
    }
    finished = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeLimit);
    attempt?.removeEventListener("abort", onAttemptAbort);
  }
  return {
    timedOut,
    stepLimit,
    // An abort wins over an error: the adapter often reports the cancelled request as one.
    stopped: abortController.signal.aborted,
    error,
    finished,
    transcript: answeredCalls(messages.filter((entry) => !unanswered.has(entry.toolCallId ?? ""))),
    usage: billed.length > 0 ? totalUsage(billed) : null,
    failure,
  };
}

/**
 * Records one model call's usage against the Quota, in its bill's Checkpoint transaction. Returns
 * the `onUsage` firing, for once that transaction has committed.
 */
type ModelCallRecorder = (
  tx: Transaction,
  usage: MessageUsage,
  reportedCost: number | undefined,
) => Promise<() => void>;

/**
 * What one model call bills: the usage its Provider reported, else an estimate from its input and
 * output. A call that failed with no usage reported bills nothing.
 */
function callUsage(
  deps: BotSdkContext,
  provider: string,
  chunks: StreamChunk[],
  messages: ModelMessage[],
): { usage: MessageUsage; reportedCost?: number } | null {
  const reported = reportedUsageOf(provider, chunks);
  if (!reported.usage && chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)) return null;
  const output = chunks
    .map((chunk) =>
      chunk.type === EventType.TEXT_MESSAGE_CONTENT || chunk.type === EventType.TOOL_CALL_ARGS
        ? chunk.delta
        : "",
    )
    .join("");
  return {
    usage: deps.plugin("models").messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [{ type: "text", text: output }],
    }),
    reportedCost: reported.cost,
  };
}

/** The Turn's usage: the sum of what its model calls billed, an estimate if any of them was. */
function totalUsage(calls: MessageUsage[]): MessageUsage {
  let total: Omit<MessageUsage, "estimated"> | undefined;
  for (const { estimated: _estimated, ...call } of calls) total = addUsage(total, call);
  return { ...total!, estimated: calls.some((call) => call.estimated) };
}

/** A chunk without the Provider's raw event, which the history needn't keep. */
function withoutRaw(chunk: StreamChunk): StreamChunk {
  if (!("rawEvent" in chunk)) return chunk;
  const { rawEvent: _raw, ...rest } = chunk;
  return rest as StreamChunk;
}

/** How a Turn ended, and why when it failed: a limit's code or the Provider's error. */
function endingOf({
  timedOut,
  stepLimit,
  stopped,
  error,
  finished,
}: Pick<PlayedTurn, "timedOut" | "stepLimit" | "stopped" | "error" | "finished">): {
  status: TurnStatus;
  error: string | null;
} {
  if (timedOut) return { status: "error", error: "timed_out" };
  if (stopped) return { status: "stopped", error: null };
  if (error !== undefined) return { status: "error", error };
  if (stepLimit) return { status: "error", error: "step_limit" };
  return finished ? { status: "complete", error: null } : { status: "stopped", error: null };
}

/** Whether the last Step ended in non-empty plain text and no tool call. */
function endsInPlainText(messages: readonly ModelMessage[]): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.toolCalls?.length) return false;
  const content =
    typeof last.content === "string"
      ? last.content
      : (last.content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");
  return content.trim() !== "";
}

/**
 * The transcript without tool calls that never got a result (a Turn cut off mid-Step), which a
 * Provider would refuse when the transcript is replayed.
 */
function answeredCalls(messages: readonly ModelMessage[]): ModelMessage[] {
  const answered = new Set(
    messages.flatMap((entry) => (entry.toolCallId ? [entry.toolCallId] : [])),
  );
  return messages.flatMap((entry) => {
    if (!entry.toolCalls) return [entry];
    const toolCalls = entry.toolCalls.filter((call) => answered.has(call.id));
    if (toolCalls.length === entry.toolCalls.length) return [entry];
    const { toolCalls: _dropped, ...rest } = entry;
    if (toolCalls.length > 0) return [{ ...rest, toolCalls }];
    return rest.content ? [rest] : [];
  });
}
