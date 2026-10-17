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
import { bot, botTurn, conversation, message } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { searchTextOf } from "../../../core/shared/message-parts";
import { conversationChannel } from "../../assistant/server/memory/notice";
import { addUsage, promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import { parseModelId } from "../../models/shared/models";
import type { MessageUsage } from "../../models/shared/usage";
import { defineJob, PermanentJobError } from "../../runner/server/jobs/define";
import { loadHistory } from "../../runner/server/jobs/history";
import {
  createWorkflow,
  type WorkflowContext,
  WorkflowYieldedError,
} from "../../runner/server/workflow/engine";
import type { BotMessage, BotSendEvent, TurnStatus } from "../shared/turn";
import { botMessages, findBot, textParts, toBotMessage, turnTimeLimitMs } from "./store";

/** The most Steps a Turn may take; one more ends it `error` with `step_limit`. */
export const turnStepLimit = 10;

/** The Bot's one tool in step 1: the only way it reaches the user. */
export const sendToUserToolName = "send_to_user";

/** The fixed Bot system prompt: there are no per-Bot instructions. */
export const botSystemPrompt =
  "You are a Bot the user talks to in a messenger. The user never sees your text replies or your " +
  `tool calls; they see only the messages you send with the ${sendToUserToolName} tool. To say ` +
  `something, call ${sendToUserToolName}. You may call it more than once, in order. Set endTurn to ` +
  "true on your last message, so you stop there. If there is nothing worth saying (the user just " +
  "acknowledged, said goodbye for now, or needs no answer), send nothing and reply without calling " +
  "a tool.";

/** What SendToUser returns for an empty `text`: what went wrong, and what to do instead. */
export const emptyTextError =
  `The message was not sent: text is empty. Call ${sendToUserToolName} again with the words the ` +
  "user should read, or, if there is nothing worth saying, reply without calling a tool.";

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
  name: "bot.turn",
  payload: z.object({ turnId: z.uuid() }),
  run: ({ turnId }, ctx) => runTurnJob(ctx.deps, turnId, ctx),
  onFailed: ({ turnId }, _error, deps) => endLostTurn(deps, turnId),
  onCancelled: ({ turnId }, deps) => endStoppedTurn(deps, turnId),
});

/**
 * Saves the user's Message, creates its Turn and queues the Turn's job, in one transaction. Checks
 * run before anything is written, and a refusal throws an RPC error before the stream starts. The
 * returned stream follows the Turn from Postgres: the saved user Message, each Message the Turn
 * sends, then `turnEnded`. Leaving it ends only the follow, never the Turn.
 */
export async function sendToBot(
  deps: BotSdkContext,
  {
    userId,
    botId,
    text,
    signal,
  }: { userId: string; botId: string; text: string; signal?: AbortSignal },
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

  // A Turn on Host credentials is refused once its Quota's window has spent the budget (ADR 0007),
  // before the user's Message is saved. It is checked here only, so a resumed Turn is never refused.
  if (!(await call.meter.mayRun()).ok) {
    throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
  }

  const runner = deps.plugin("runner");
  const now = deps.clock();
  const turnId = uuidv7();
  const userMessage = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, so two sends can't both find no Turn running.
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, found.conversationId))
      .for("update");
    const [running] = await tx
      .select({ id: botTurn.id })
      .from(botTurn)
      .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")))
      .limit(1);
    if (running) {
      throw rpcError("CONFLICT", "error.turnRunning", "A Turn is still running for this Bot");
    }
    const row = await appendMessage(tx, found.conversationId, {
      role: "user",
      parts: textParts(text),
      status: "complete",
      createdAt: now,
    });
    const jobId = await runner.enqueueIn(
      tx,
      botTurnJob.name,
      { turnId },
      { idempotencyKey: turnId },
    );
    // A ms after its Message, so the replayed history puts the Turn after the Message it answers.
    await tx.insert(botTurn).values({
      id: turnId,
      botId,
      status: "running",
      startedAt: new Date(now.getTime() + 1),
      jobId,
    });
    return toBotMessage(row);
  });
  runner.wake();

  return followTurn(deps, { conversationId: found.conversationId, turnId, userMessage, signal });
}

/**
 * Stops the Bot's running Turn by cancelling its job (#482, #483). A queued Turn ends `stopped`
 * in the same transaction, so its job never runs; a running one ends `stopped` as its attempt
 * aborts (`runTurnJob`). Does nothing when no Turn is running.
 */
export async function stopBot(deps: BotSdkContext, userId: string, botId: string): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const runner = deps.plugin("runner");
  const ended = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in `sendToBot`.
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, found.conversationId))
      .for("update");
    const [running] = await tx
      .select({ id: botTurn.id })
      .from(botTurn)
      .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")))
      .limit(1);
    if (!running) return false;
    if ((await runner.cancelIn(tx, running.id)) !== "queued") return false;
    // A queued job may have run already (handed back by a deploy, waiting out a retry, or re-queued
    // after a crash), so the Turn keeps what its Checkpoints hold. The job's row is locked, so its
    // history can't grow while it replays.
    const turn = await turnFacts(deps, running.id);
    const played = turn ? await replayedTurn(deps, turn) : { transcript: [], usage: null };
    await endTurn(tx, running.id, {
      status: "stopped",
      error: null,
      transcript: played.transcript,
      usage: played.usage,
      endedAt: deps.clock(),
    });
    return true;
  });
  if (ended) await hintChanged(deps, found.conversationId);
}

/**
 * Follows a Turn from Postgres (#483, slide 19's "signal, then fetch"): yields the user Message,
 * then re-reads on each "changed" hint on the Conversation's channel, and every `followPollMs` in
 * case a hint is lost, yielding each new Message, until the Turn has ended.
 */
async function* followTurn(
  deps: BotSdkContext,
  {
    conversationId,
    turnId,
    userMessage,
    signal,
  }: { conversationId: string; turnId: string; userMessage: BotMessage; signal?: AbortSignal },
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
      const [turn] = await deps.db
        .select({ status: botTurn.status })
        .from(botTurn)
        .where(eq(botTurn.id, turnId));
      for (const sent of await botMessages(deps.db, conversationId, userMessage.createdAt)) {
        if (shown.has(sent.id)) continue;
        shown.add(sent.id);
        yield { type: "message", message: sent };
      }
      if (turn?.status !== "running") {
        yield { type: "turnEnded", status: turn?.status ?? "error" };
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

async function turnFacts(deps: BotSdkContext, turnId: string): Promise<TurnFacts | undefined> {
  const [row] = await deps.db
    .select({
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
  const turn = await turnFacts(deps, turnId);
  if (!turn) throw new PermanentJobError(`Turn ${turnId} no longer exists`);
  const played = await playTurn(deps, turn, ctx, { attempt: ctx.signal });
  try {
    ctx.signal.throwIfAborted();
    // A thrown activity recorded nothing: the job retries it.
    if (played.failure !== undefined) throw played.failure;
    await ctx.activity("end_turn", (tx) =>
      endTurn(tx, turnId, {
        ...endingOf(played),
        transcript: played.transcript,
        usage: played.usage,
        endedAt: deps.clock(),
      }),
    );
  } catch (caught) {
    // Also when the abort lands after the Turn played, before or during its end_turn Checkpoint.
    if (ctx.signal.aborted) await stopIfCancelled(deps, turn, played);
    throw caught;
  }
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
  const turn = await turnFacts(deps, turnId);
  if (!turn) return;
  let played: Pick<PlayedTurn, "transcript" | "usage"> = { transcript: [], usage: null };
  try {
    played = await replayedTurn(deps, turn);
  } catch (caught) {
    // The Turn still ends, so it never reads `running` forever; only its transcript is lost.
    deps.logger.error(`Replaying the Checkpoints of Turn ${turnId} failed`, caught);
  }
  await endRunningTurn(deps, turn, ending, played);
}

/** Ends a Turn still `running` as `ending` says, with `played`'s transcript and usage. */
async function endRunningTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
  ending: { status: TurnStatus; error: string | null },
  played: Pick<PlayedTurn, "transcript" | "usage">,
) {
  await deps.db
    .update(botTurn)
    .set({ ...ending, transcript: played.transcript, usage: played.usage, endedAt: deps.clock() })
    .where(and(eq(botTurn.id, turn.id), eq(botTurn.status, "running")));
  await hintChanged(deps, turn.conversationId);
}

/**
 * What a Turn whose job has ended did: its recorded calls replay, and the first one past them
 * stops the Turn there. Its transcript and usage are those of the recorded calls.
 */
async function replayedTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
): Promise<Pick<PlayedTurn, "transcript" | "usage">> {
  const workflow = createWorkflow<Transaction>({
    history: turn.jobId ? await loadHistory(deps.db, turn.jobId) : [],
    store: {
      save: async () => false,
      saveWith: async () => ({ saved: false }),
    },
    now: deps.clock,
    signal: AbortSignal.abort(new Error("The Turn's job has ended")),
  });
  return playTurn(deps, turn, workflow.context, {});
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
async function modelInput(deps: BotSdkContext, turn: TurnFacts): Promise<ModelMessage[]> {
  const [users, turns] = await Promise.all([
    deps.db
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
    deps.db
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
 * tool call ends the Turn quiet; the Step and time limits end it `error`.
 *
 * `attempt`, when given, is the attempt's signal: the live call stops when it aborts.
 */
async function playTurn(
  deps: BotSdkContext,
  turn: TurnFacts,
  ctx: WorkflowContext<Transaction>,
  { attempt }: { attempt?: AbortSignal },
): Promise<PlayedTurn> {
  const input = await modelInput(deps, turn);
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
  let engine: ChatMiddlewareContext | undefined;
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

  const sendToUser = sendToUserDefinition.server(async ({ text, endTurn: last }, context) => {
    try {
      // The Message commits with its Checkpoint, so it is sent once across a crash.
      const result = await ctx.activity(sendToUserToolName, async (tx) => {
        // Run only live, so a recorded send still replays: past the limit, a resumed Turn sends
        // nothing more, and never answers a question from long ago.
        if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
        abortController.signal.throwIfAborted();
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
    } catch (caught) {
      // A time limit or a stop recorded nothing, and isn't a failure to retry.
      if (!abortController.signal.aborted) failure ??= caught;
      if (context?.toolCallId) unanswered.add(context.toolCallId);
      abortController.abort();
      throw caught;
    }
  });

  try {
    const stream = chat({
      adapter: durableAdapter,
      messages: input,
      systemPrompts: [botSystemPrompt],
      tools: [sendToUser],
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
            if (state.lastTurnToolCallCount > 0 && state.iterationCount >= turnStepLimit) {
              stepLimit = true;
              return false;
            }
            return true;
          },
        },
      ],
    });
    for await (const chunk of stream) {
      if (chunk.type === EventType.RUN_ERROR) error = chunk.message;
    }
    finished = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeLimit);
    attempt?.removeEventListener("abort", onAttemptAbort);
  }
  const messages = engine ? engine.messages.slice(engine.messageCount) : [];
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
