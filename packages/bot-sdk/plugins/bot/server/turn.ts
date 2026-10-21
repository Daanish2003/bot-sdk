import { type AnyServerTool, type ModelMessage, toolDefinition } from "@tanstack/ai";
import { and, asc, desc, eq, gt, gte, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botTrigger, botTurn, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { searchTextOf } from "../../../core/shared/message-parts";
import { conversationChannel } from "../../../core/server/chat/conversation-events";
import type { MessageUsage } from "../../models/shared/usage";
import { defineJob, PermanentJobError } from "../../runner/server/jobs/define";
import { loadHistory } from "../../runner/server/jobs/history";
import { createWorkflow, type WorkflowContext } from "../../runner/server/workflow/engine";
import { routineScheduleSchema } from "../shared/routine";
import type { BotMessage, BotSendEvent, TurnStatus } from "../shared/turn";
import {
  botTurnJobName,
  lockConversation,
  receive,
  turnEnded,
  turnStarted,
  waitingIn,
} from "./router";
import { type EarlierTurn, changeNotesFor } from "./change-notes";
import type { PromptStartTool } from "./db/bot-prompt-start";
import { cancelCheckInTool, pendingCheckIns, saveCheckIn } from "./check-in";
import {
  capText,
  computerOf,
  computerPrompt,
  computerToolDefinitions,
  spillPath,
  spillThreshold,
} from "./computer-tools";
import { type TodoItem, todoList } from "./helper";
import { helperTools } from "./helper-tools";
import { type LoopKit, type LoopResult, type LoopSetup, runLoop } from "./loop";
import {
  definitionsOf,
  loopPromptStart,
  previousTurnCall,
  type PromptStartParts,
  promptStartFor,
} from "./prompt-start";
import { historyFrom, historyTurns, queueAwaySummary, summaryOf, writeSummary } from "./summary";
import { botMessages, findBot, textParts, toBotMessage, turnTimeLimitMs } from "./store";
import {
  createRoutineToolName,
  deleteRoutine,
  deleteRoutineToolName,
  routinesPrompt,
  saveRoutine,
  updateRoutine,
  updateRoutineToolName,
} from "./routine";
import { formatterIn, knownZone, timeNotice } from "./time-zone";
import { checkedTool, isDirectTool, toolSearchTools } from "./tool-search";
import { webSearchTool } from "./web-search";

/** The most Steps a Turn may take; one more ends it `error` with `step_limit`. */
export const turnStepLimit = 10;

/** The Bot's tool for reaching the user: the only way it does. */
export const sendToUserToolName = "send_to_user";

/** The Bot tool that sets a Check-in for itself, with no Approval (#540). */
export const setCheckInToolName = "set_check_in";

/** The Bot tool that cancels one of its pending Check-ins (#540). */
export const cancelCheckInToolName = "cancel_check_in";

/** The Bot tool that lists its pending Check-ins (#540). */
export const listCheckInsToolName = "list_check_ins";

/** The tool that searches the Bot's memory files (ADR 0022). */
export const searchMemoryToolName = "search_memory";

const promptOpening =
  "You are a Bot the user talks to in a messenger. The user never sees your text replies or your " +
  `tool calls; they see only the messages you send with the ${sendToUserToolName} tool. `;

/** What the Bot can't do, with no Computer. */
const onlyToolLimits =
  "Besides it, you have only web_search: you cannot send email or messages to anyone else, or act " +
  "outside this chat. ";

/** What the Bot can't do, with its Computer. */
const computerLimits =
  "Besides it, you have only web_search and your computer (below): you cannot send email or " +
  "messages to anyone else. ";

/**
 * The Bot's rules, with or without its Computer. The sentence after "say plainly that you cannot"
 * is a recorded deviation from eval tuning (#575): gpt-5.4-mini answered "I can send the summary if
 * you paste it here, but I can't message your boss directly".
 */
const promptRules =
  "When asked to, say plainly that you cannot, then offer what you can do. Start with the refusal " +
  `(for example, "I can't send email"), and never offer to send anything to anyone but the user. ` +
  `To say something, call ${sendToUserToolName}. You may call it more than once, in order. Set endTurn to ` +
  "true on your last message, so you stop there. Anything you want the user to read goes through " +
  "it, including a refusal (you cannot do what they asked) and a question you need answered. If " +
  "there is nothing worth saying (the user just acknowledged, said goodbye for now, or needs no " +
  "answer), send nothing: reply with no text and no tool call, not even to say you are staying " +
  "quiet. Do not send a pleasantry (you're welcome, good luck, see you) in reply to one. " +
  `When the user asks for something to happen on a schedule, save it with ${createRoutineToolName}; ` +
  "it runs only once the user approves it, and it repeats. For a one-time reminder, or to come back to something once, at a time you choose, " +
  `set a Check-in with ${setCheckInToolName}; it needs no approval, ${listCheckInsToolName} shows ` +
  `the ones you have pending, and ${cancelCheckInToolName} cancels one. When a Routine run finds ` +
  "nothing new worth telling the user, send nothing, not even to say so. When a Check-in you set " +
  "fires, do what its note says.";

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

/** The Checkpoint that stores the Turn's newest message, before its first model call. */
const turnInputActivity = "turn_input";

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

/** A Routine's name: a slug, unique per Bot. */
const routineName = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'name must be a slug: lowercase letters, digits and hyphens, like "morning-brief"',
  )
  .max(60, "name must be at most 60 characters");

const createRoutineDefinition = toolDefinition({
  name: createRoutineToolName,
  description:
    "Save a Routine: a prompt that repeats on a schedule (days of the week at a time in the user's " +
    "time zone) or whenever an outside service calls its webhook URL, never a one-time reminder. Give exactly one of schedule or " +
    "webhook. Use it when the user asks for something recurring, or for something to happen when " +
    "another service sends an event. It runs only once the user approves it, and each run wakes " +
    "you with its prompt. The user gets a webhook Routine's URL in the app; you never see it.",
  inputSchema: z.object({
    name: routineName.meta({
      description: 'A short slug naming the Routine, like "morning-brief".',
    }),
    prompt: z
      .string()
      .trim()
      .min(1, "prompt must not be empty")
      .meta({ description: "What to do on each run, written as an instruction to yourself." }),
    schedule: routineScheduleSchema.optional().meta({
      description:
        'When it runs, like { "days": ["mon", "tue", "wed", "thu", "fri"], "at": "08:00" }. ' +
        "Leave it out for a webhook Routine.",
    }),
    webhook: z
      .boolean()
      .optional()
      .meta({
        description:
          "true to run whenever its webhook URL is called, in place of a schedule. A run reads what " +
          "the call sent after the prompt, as untrusted data.",
      }),
  }),
});

const updateRoutineDefinition = toolDefinition({
  name: updateRoutineToolName,
  description:
    "Change the prompt or the schedule of one of your Routines, named as in your list. A change to " +
    "a Routine the user approved sends it back for their OK: it stops running until they approve it.",
  inputSchema: z.object({
    name: routineName.meta({ description: "The name of the Routine to change." }),
    prompt: z
      .string()
      .trim()
      .min(1, "prompt must not be empty")
      .optional()
      .meta({ description: "The new prompt; leave it out to keep the current one." }),
    schedule: routineScheduleSchema.optional().meta({
      description: "The new schedule; leave it out to keep the current one.",
    }),
  }),
});

const deleteRoutineDefinition = toolDefinition({
  name: deleteRoutineToolName,
  description: "Delete one of your Routines, named as in your list. It never runs again.",
  inputSchema: z.object({
    name: routineName.meta({ description: "The name of the Routine to delete." }),
  }),
});

const setCheckInDefinition = toolDefinition({
  name: setCheckInToolName,
  description:
    "Set a Check-in: a one-time reminder or wake-up at a moment you choose, with a note to your future self. It needs no approval " +
    "and fires once. Use it for a reminder (remind me on Friday), or to follow up later, like checking on Thursday whether someone replied. " +
    "Anything that repeats is a Routine instead.",
  inputSchema: z.object({
    at: z.iso
      .datetime({ offset: true, message: "at must be an ISO 8601 time with an offset" })
      .meta({
        description:
          'When to wake, with an explicit offset, like "2026-10-22T09:00:00+01:00". At least a minute from now.',
      }),
    note: z.string().trim().min(1, "note must not be empty").meta({
      description: "What you will want to remember when you wake, as a note to yourself.",
    }),
  }),
});

const cancelCheckInDefinition = toolDefinition({
  name: cancelCheckInToolName,
  description:
    "Cancel one of your pending Check-ins, by the id list_check_ins or set_check_in gave.",
  inputSchema: z.object({ id: z.uuid().meta({ description: "The Check-in id." }) }),
});

const searchMemoryDefinition = toolDefinition({
  name: searchMemoryToolName,
  description:
    "Search your memory: your Profile, every Log month and your Notes, and all the Bots' " +
    "Profiles. Returns the 10 best matching lines with file and date. Use it for what the " +
    "memory in your prompt doesn't hold.",
  inputSchema: z.object({
    query: z.string().min(1).meta({ description: "What to look for in your memory" }),
  }),
});

const listCheckInsDefinition = toolDefinition({
  name: listCheckInsToolName,
  description: "List your pending Check-ins, soonest first, so you do not set the same one twice.",
  inputSchema: z.object({}),
});

/**
 * Tells whoever follows the Conversation that it changed, so they re-read it from Postgres. Never
 * throws: a lost hint is covered by the follower's re-read every `followPollMs`.
 */
export async function hintChanged(deps: BotSdkContext, conversationId: string) {
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
 * `timeZone` is the user's IANA zone, kept on the Message.
 */
export async function sendToBot(
  deps: BotSdkContext,
  {
    userId,
    botId,
    id,
    text,
    timeZone,
    signal,
  }: {
    userId: string;
    botId: string;
    id: string;
    text: string;
    timeZone?: string;
    signal?: AbortSignal;
  },
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
      parts: textParts(text, timeZone),
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

/** Stops the running Turn of each of the user's Bots, as `stopBot` does (#585): a Ban calls it. */
export async function stopUserTurns(deps: BotSdkContext, userId: string): Promise<void> {
  const bots = await deps.db.select({ id: bot.id }).from(bot).where(eq(bot.userId, userId));
  for (const { id } of bots) await stopBot(deps, userId, id);
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
  const endedAt = deps.clock();
  await endTurn(tx, turnId, {
    status: "stopped",
    error: null,
    transcript: played.transcript,
    usage: played.usage,
    endedAt,
  });
  if (turn)
    await queueAwaySummary(deps, tx, { botId: turn.botId, lastInput: played.lastInput, endedAt });
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

/** What a Turn played: its transcript and usage, and its last Step's input when known. */
type PlayedTurn = Pick<LoopResult, "transcript" | "usage"> & { lastInput?: number };

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
  let todo: TodoItem[] | null;
  try {
    // The to-do list as the Turn starts, recorded: every attempt reads the same.
    todo = await ctx.activity(startTurnActivity, async (tx) => {
      await turnStarted(deps, tx, turnId);
      return todoList(tx, turn.botId);
    });
    // Read after the start: a resumed attempt replays it, so the Turn keeps the start it had.
    turn = (await turnFacts(deps.db, turnId)) ?? created;
  } catch (caught) {
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, { transcript: [], usage: null });
    throw caught;
  }
  const played = await playTurn(deps, turn, ctx, { attempt: ctx.signal, todo });
  try {
    ctx.signal.throwIfAborted();
    // A thrown activity recorded nothing: the job retries it.
    if (played.failure !== undefined) throw played.failure;
    await ctx.activity("end_turn", async (tx) => {
      await lockConversation(tx, turn.conversationId);
      const endedAt = deps.clock();
      await endTurn(tx, turnId, {
        ...endingOf(played),
        transcript: played.transcript,
        usage: played.usage,
        endedAt,
      });
      await queueAwaySummary(deps, tx, { botId: turn.botId, lastInput: played.lastInput, endedAt });
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
async function stopIfCancelled(deps: BotSdkContext, turn: TurnFacts, played: PlayedTurn) {
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
    await lockConversation(tx, turn.conversationId);
    const endedAt = deps.clock();
    const rows = await tx
      .update(botTurn)
      .set({ ...ending, transcript: played.transcript, usage: played.usage, endedAt })
      .where(and(eq(botTurn.id, turn.id), eq(botTurn.status, "running")))
      .returning({ id: botTurn.id });
    if (rows.length === 0) return false;
    await queueAwaySummary(deps, tx, { botId: turn.botId, lastInput: played.lastInput, endedAt });
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
        ? await workflow.context.activity<TodoItem[] | null>(startTurnActivity, async () => null)
        : null;
    return await playTurn(deps, turn, workflow.context, { db, todo });
  } catch (caught) {
    // The job ended before it stored the Turn's input, so the Turn sent nothing.
    if (caught === ended.reason) return { transcript: [], usage: null };
    throw caught;
  }
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

const sinceTime: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The Bot's to-do list (#567), after the time notice: one line per running or waiting Helper,
 * `<id> · General · running: <gist> · since 10:42`, the time in the user's zone. A Helper waiting
 * on a hand-off reads `waiting for the user: <reason> · task: <gist>`.
 */
function todoNotice(todo: TodoItem[], stored: string | undefined): string {
  const since = formatterIn(knownZone(stored), sinceTime);
  const lines = todo.map((item) => {
    const kind = item.type === "general" ? "General" : "Computer-use";
    const state = item.status === "waiting" ? "waiting for the user" : "running";
    const doing = item.reason === undefined ? item.gist : `${item.reason} · task: ${item.gist}`;
    return `${item.id} · ${kind} · ${state}: ${doing} · since ${since.format(new Date(item.startedAt))}`;
  });
  return ["[Your to-do list: the Helpers still working or waiting for the user]", ...lines].join(
    "\n",
  );
}

/**
 * When the Bot's last Turn before `turn` that took its input started: the last one that stored its
 * input, or one from before Turns stored it (a transcript and no input), whose Messages are not
 * rendered again. `undefined` for the Bot's first Turn.
 */
async function lastInputAt(db: Database | Transaction, turn: TurnFacts): Promise<Date | undefined> {
  const [row] = await db
    .select({ startedAt: botTurn.startedAt })
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, turn.botId),
        lt(botTurn.startedAt, turn.startedAt),
        // A Turn stores its input before its first model call, so one with a transcript and no
        // input is from before inputs were stored. One that never ran (stopped while queued, or
        // failed before its first call) has neither, and what it took is still new.
        or(isNotNull(botTurn.input), sql`jsonb_array_length(${botTurn.transcript}) > 0`),
      ),
    )
    .orderBy(desc(botTurn.startedAt), desc(botTurn.id))
    .limit(1);
  return row?.startedAt;
}

/**
 * The Turn's newest message, rendered once: what arrived since `since`, the start of the last Turn
 * that stored its input, in order. Each user Message is a user turn, and each Trigger with no Message (such as a Routine's
 * fire) an input turn of its text, through `cutTrigger`, which cuts a long one once (#668). The
 * newest opens with the time in the newest user Message's zone, as of the Turn's start, then the
 * Change notes (#671), then the to-do list as the Turn's start Checkpoint recorded it. Only what came before the Turn counts, so
 * every attempt reads the same.
 */
async function newestInput(
  db: Database | Transaction,
  turn: TurnFacts,
  since: Date | undefined,
  todo: TodoItem[] | null,
  changeNotes: string | undefined,
  cutTrigger: (id: string, text: string) => Promise<string>,
): Promise<ModelMessage[]> {
  const beforeTurn = and(
    eq(message.conversationId, turn.conversationId),
    eq(message.role, "user"),
    lt(message.createdAt, turn.startedAt),
  );
  const [users, woken, [newestUser]] = await Promise.all([
    db
      .select({ parts: message.parts, createdAt: message.createdAt })
      .from(message)
      .where(and(beforeTurn, since && gte(message.createdAt, since)))
      .orderBy(asc(message.createdAt), asc(message.id)),
    // The Triggers that carry no Message (a Routine's fire, #539), taken and received by the time
    // this Turn started: never one taken later. A Turn's input holds the ones taken and received by
    // its start, so one a Stop handed to it later goes to the next Turn, once.
    db
      .select({ id: botTrigger.id, text: botTrigger.text, receivedAt: botTrigger.receivedAt })
      .from(botTrigger)
      .innerJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
      .where(
        and(
          eq(botTrigger.conversationId, turn.conversationId),
          ne(botTrigger.source, "user"),
          isNotNull(botTrigger.text),
          lte(botTurn.startedAt, turn.startedAt),
          lte(botTrigger.receivedAt, turn.startedAt),
          since && or(gt(botTurn.startedAt, since), gt(botTrigger.receivedAt, since)),
        ),
      )
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id)),
    db
      .select({ parts: message.parts })
      .from(message)
      .where(beforeTurn)
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(1),
  ]);
  const inputs = users.map((row) => ({
    at: row.createdAt.getTime(),
    content: searchTextOf(row.parts),
  }));
  // One at a time: each long one is an activity, in a stable order.
  for (const row of woken) {
    inputs.push({ at: row.receivedAt.getTime(), content: await cutTrigger(row.id, row.text!) });
  }
  // A stable sort keeps a user Message before a Trigger received at the same time.
  inputs.sort((a, b) => a.at - b.at);
  const newest = inputs.at(-1);
  if (newest) {
    const zone = newestUser?.parts.timeZone;
    // The Change notes share the time's block, which holds no user text: only there are they read
    // back as told (`notesIn`).
    const time = timeNotice(turn.startedAt, zone);
    const notices = [
      changeNotes ? `${time}\n${changeNotes}` : time,
      ...(todo?.length ? [todoNotice(todo, zone)] : []),
    ];
    newest.content = `${notices.join("\n\n")}\n\n${newest.content}`;
  }
  // One input turn each, never a user Message: a Trigger's text opens with what woke the Bot.
  return inputs.map((input) => ({ role: "user", content: input.content }));
}

/**
 * The Turn's loop (slide 2), run through `runLoop`: SendToUser, the Routine and Check-in tools and,
 * whenever `computer` is on, the Computer's tools and `start_helper`. A SendToUser's Message commits with its
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
  // A long Trigger of this Turn is cut once, in an activity: the full text goes to the Computer,
  // and a replay reads the recorded cut text without waking it.
  const cutTrigger = (id: string, text: string) =>
    text.length <= spillThreshold
      ? Promise.resolve(text)
      : ctx.activity(
          "trigger_text",
          async () => {
            const computer = deps.hasPlugin("computer") ? computerOf(deps, turn.userId) : undefined;
            return capText(
              text,
              spillPath(turn.botId, id),
              computer && ((path, content) => computer.writeFile(path, content)),
            );
          },
          { yields: false },
        );
  // History is each earlier Turn's stored input, then its transcript, from the Prompt start's
  // Summary on (`turnSetup`): nothing is rendered again, so its bytes never change. What an earlier
  // Turn sent is in its input; only what came after the last such Turn started is new.
  const since = await lastInputAt(db, turn);
  // The newest message holds the Change notes, which are read in the loop's setup: it is rendered
  // there, once the Turn's Prompt start is chosen. Stored before the first model call, so a
  // stopped or interrupted Turn keeps what it sent, and a replay reads the recorded input.
  const renderNewest = async (changeNotes: string | undefined) => {
    const rendered = await newestInput(db, turn, since, todo, changeNotes, cutTrigger);
    return ctx.activity(turnInputActivity, async (tx) => {
      await tx.update(botTurn).set({ input: rendered }).where(eq(botTurn.id, turn.id));
      return rendered;
    });
  };
  return runLoop(deps, ctx, {
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
    // Each shell call of the Turn gets Auto-review before it runs (spec #691).
    review: { turnId: turn.id, conversationId: turn.conversationId },
    setup: (kit) => turnSetup(deps, turn, kit, db, renderNewest),
  });
}

/**
 * The Turn's tools and its Prompt start, given the loop's `kit`: the Bot's latest, or the one its
 * first Turn builds from the system blocks and tools as they are now. Memory and Routines are still
 * read every Turn (ADR 0022, amended), but the Prompt start keeps them as they were when it was
 * built. History is the earlier Turns from its Summary on, the only ones read. A Summary written mid-Turn builds the
 * next Prompt start from the tools and the system blocks as this Turn read them at its start.
 * `db` reads the stored Prompt start.
 */
async function turnSetup(
  deps: BotSdkContext,
  turn: TurnFacts,
  kit: LoopKit,
  db: Database | Transaction,
  renderNewest: (changeNotes: string | undefined) => Promise<ModelMessage[]>,
): Promise<LoopSetup> {
  let endTurn = false;
  // The Bot's Routines as the Turn starts, read once: a replay reads the recorded list.
  const routines = await kit.liveActivity(
    "routines",
    undefined,
    async (tx) => (await routinesPrompt(tx, turn.botId)) ?? null,
  );
  // The Computer's tools and Helpers, whenever `computer` is on: the tool set never changes
  // mid-conversation.
  const withComputer = deps.hasPlugin("computer");
  const memory =
    withComputer && deps.hasPlugin("memory") ? await memorySnapshot(deps, turn, kit) : null;
  const tools = turnTools(deps, turn, kit, {
    withComputer,
    // Present whenever the snapshot is: it reads through the Computer like the snapshot does.
    withMemorySearch: memory !== null,
    onLastMessage: () => {
      endTurn = true;
    },
  });
  // `describe_tool` and `run_tool`, which reach the tools the Prompt start lists by name only.
  const searchTools = toolSearchTools(tools);
  /** What a Prompt start is built from now: by the Bot's first Turn, or by a Summary. */
  const parts = (): PromptStartParts =>
    startParts(turn, deps.clock(), { tools, withComputer, memory, routines });
  // Recorded, so a replay sends the row its attempt chose.
  const { id } = await kit.liveActivity("prompt_start", undefined, async (tx) => ({
    id: await promptStartFor(tx, parts()),
  }));
  const promptStart = await loopPromptStart(db, id, () => previousTurnCall(deps.db, turn));
  const summary = await summaryOf(db, id);
  const earlier = await historyTurns(db, turn.botId, summary, turn.startedAt);
  // A mid-Turn Summary's Prompt start was built from what its Turn read at its start, so what the
  // Bot saw and did in that Turn counts as seen since it too.
  const seenSince: EarlierTurn[] = earlier.map((row) =>
    summary?.kind === "mid_turn" && row.id === summary.turnId ? { ...row, promptStartId: id } : row,
  );
  // What changed since the Prompt start, from what this Turn read: the memory block and Routines
  // as recorded above, and the live tools.
  const changeNotes = await changeNotesFor(db, id, seenSince, {
    memory,
    routines: routines ?? null,
    tools: definitionsOf(tools),
  });
  // A tool a deploy removed stays defined, as the Prompt start sends it, and says it is gone.
  const known = new Set([...tools, ...searchTools].map((tool) => tool.name));
  const retired = promptStart.tools.filter((tool) => !known.has(tool.name)).map(retiredTool);
  return {
    promptStart,
    history: historyFrom(earlier, summary),
    summarize: {
      write: (tx, prose) => writeSummary(tx, { parts: parts(), prose, kind: "mid_turn" }),
      load: (summarized) => loopPromptStart(db, summarized, async () => undefined),
    },
    tools: [...[...tools, ...searchTools].map(checkedTool), ...retired],
    ended: () => endTurn,
    newest: await renderNewest(changeNotes),
  };
}

/**
 * The Bot's tools for a Turn, run through the loop's `kit`: SendToUser, the Routine and Check-in
 * tools, web search, `search_memory` with `withMemorySearch`, and with `withComputer` the
 * Computer's tools and the Helper tools. `onLastMessage` runs when SendToUser sends the Turn's last
 * Message.
 */
function turnTools(
  deps: BotSdkContext,
  turn: TurnFacts,
  kit: LoopKit,
  {
    withComputer,
    withMemorySearch,
    onLastMessage,
  }: { withComputer: boolean; withMemorySearch: boolean; onLastMessage: () => void },
): AnyServerTool[] {
  const { liveActivity } = kit;
  const sendToUser = sendToUserDefinition.server(async ({ text, endTurn: last }, context) => {
    // The Message commits with its Checkpoint, so it is sent once across a crash.
    const result = await liveActivity(sendToUserToolName, context?.toolCallId, async (tx) => {
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
      if (last) onLastMessage();
      await hintChanged(deps, turn.conversationId);
    }
    return result;
  });

  // The Turn carries on once the Routine is saved: the Approval is the Routine's, not the call's.
  const createRoutine = createRoutineDefinition.server(async (input, context) =>
    liveActivity(createRoutineToolName, context?.toolCallId, (tx) =>
      saveRoutine(tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        now: deps.clock(),
      }),
    ),
  );

  const updateRoutineTool = updateRoutineDefinition.server(async (input, context) =>
    liveActivity(updateRoutineToolName, context?.toolCallId, (tx) =>
      updateRoutine(deps, tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
        now: deps.clock(),
      }),
    ),
  );

  const deleteRoutineTool = deleteRoutineDefinition.server(async (input, context) =>
    liveActivity(deleteRoutineToolName, context?.toolCallId, (tx) =>
      deleteRoutine(deps, tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
      }),
    ),
  );

  const setCheckInTool = setCheckInDefinition.server(async ({ at, note }, context) =>
    liveActivity(setCheckInToolName, context?.toolCallId, (tx) =>
      saveCheckIn(deps, tx, {
        botId: turn.botId,
        turnId: turn.id,
        at: new Date(at),
        note,
        now: deps.clock(),
      }),
    ),
  );

  const cancelCheckInToolImpl = cancelCheckInDefinition.server(async ({ id }, context) =>
    liveActivity(cancelCheckInToolName, context?.toolCallId, (tx) =>
      cancelCheckInTool(deps, tx, { botId: turn.botId, conversationId: turn.conversationId, id }),
    ),
  );

  const listCheckInsTool = listCheckInsDefinition.server(async (_input, context) =>
    liveActivity(listCheckInsToolName, context?.toolCallId, async (tx) => ({
      checkIns: await pendingCheckIns(tx, turn.botId),
    })),
  );

  const searchMemory = withMemorySearch
    ? searchMemoryDefinition.server(async ({ query }, context) =>
        kit.computerCall(searchMemoryToolName, context?.toolCallId, async (_computer, live) => ({
          results: await deps.plugin("memory").searchBotMemory({
            userId: turn.userId,
            botId: turn.botId,
            query,
            now: deps.clock(),
            computer: computerOf(deps, turn.userId),
            signal: live.signal,
          }),
        })),
      )
    : null;
  return [
    sendToUser,
    createRoutine,
    updateRoutineTool,
    deleteRoutineTool,
    setCheckInTool,
    cancelCheckInToolImpl,
    listCheckInsTool,
    webSearchTool(deps, turn.userId, kit.liveRequest),
    ...(searchMemory ? [searchMemory] : []),
    ...(withComputer ? [...kit.computerTools, ...helperTools(deps, turn, liveActivity)] : []),
  ];
}

/**
 * What a Prompt start built at `now` holds: the system blocks in their fixed order, and of every
 * tool the code has now (`tools`), the direct ones and `describe_tool` and `run_tool`; the rest are
 * listed by name in its first message and reached through those two.
 */
function startParts(
  turn: PromptStartParts["turn"],
  now: Date,
  {
    tools,
    withComputer,
    memory,
    routines,
  }: {
    tools: AnyServerTool[];
    withComputer: boolean;
    memory: string | null;
    routines: string | null;
  },
): PromptStartParts {
  const [rules, computerBlock] = botSystemPrompts(turn.botId, withComputer);
  return {
    turn,
    now,
    system: [
      { name: "rules", text: rules! },
      ...(computerBlock ? [{ name: "computer", text: computerBlock }] : []),
      ...(memory ? [{ name: "memory", text: memory }] : []),
      ...(routines ? [{ name: "routines", text: routines }] : []),
    ],
    tools: [...tools.filter(isDirectTool), ...toolSearchTools(tools)],
    deferred: definitionsOf(tools.filter((tool) => !isDirectTool(tool))),
    computer: withComputer,
    memory: Boolean(memory),
  };
}

/** Stands in for a tool built only for its definition, which is never called. */
const definitionOnly = (): never => {
  throw new Error("A tool built only for its definition was called");
};

/**
 * What a Summary written while the user is away builds its Prompt start from, at `now`: the Bot's
 * tools and system blocks as a Turn starting now reads them, the Routines read in `tx` and
 * `memory`, the memory block read just before (null with Memory off or unreadable). `turn` is the
 * Bot's newest Turn, which the Summary follows.
 */
export async function awayStartParts(
  deps: BotSdkContext,
  tx: Transaction,
  turn: Omit<TurnFacts, "startedAt" | "jobId">,
  now: Date,
  memory: string | null,
): Promise<PromptStartParts> {
  const withComputer = deps.hasPlugin("computer");
  const kit: LoopKit = {
    liveActivity: definitionOnly,
    liveRequest: definitionOnly,
    computerCall: definitionOnly,
    computerTools: computerToolDefinitions.map((definition) => definition.server(definitionOnly)),
  };
  const facts: TurnFacts = { ...turn, startedAt: now, jobId: null };
  const tools = turnTools(deps, facts, kit, {
    withComputer,
    withMemorySearch: memory !== null,
    onLastMessage: definitionOnly,
  });
  const routines = (await routinesPrompt(tx, turn.botId)) ?? null;
  return startParts(facts, now, { tools, withComputer, memory, routines });
}

/** A tool the Prompt start sent that the code no longer has: it answers that it is gone. */
const retiredTool = (stored: PromptStartTool) =>
  toolDefinition({
    name: stored.name,
    description: stored.description,
    inputSchema: z.object({}).passthrough(),
  }).server(async () => ({
    error:
      `${stored.name} is no longer available (a deploy removed it, or the feature behind it is ` +
      "off). Don't call it again; use another tool for the job, or tell the user it can't be done.",
  }));

/**
 * The Bot's memory block as the Turn starts (ADR 0022), read once from the Computer as a Computer
 * call of the loop's, so a Stop or the time limit stops it: a replay reads the recorded block.
 * It reads through its own handle, so a rebuild is still told in the first tool result (#553).
 * Null with Memory off, or when the Computer can't be woken or read, so the Turn goes on without
 * it.
 */
async function memorySnapshot(
  deps: BotSdkContext,
  turn: TurnFacts,
  kit: LoopKit,
): Promise<string | null> {
  const read = await kit.computerCall("memory", undefined, async (_computer, live) => ({
    prompt: await deps.plugin("memory").botSnapshot({
      userId: turn.userId,
      botId: turn.botId,
      now: turn.startedAt,
      computer: computerOf(deps, turn.userId),
      signal: live.signal,
    }),
  }));
  return "error" in read ? null : read.prompt;
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
