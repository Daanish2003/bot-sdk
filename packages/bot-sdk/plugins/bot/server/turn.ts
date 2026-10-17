import {
  type AnyTextAdapter,
  type ChatMiddlewareContext,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  toolDefinition,
} from "@tanstack/ai";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { botTurn, conversation, message } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { searchTextOf } from "../../../core/shared/message-parts";
import { promptCharactersOf, reportedUsageOf } from "../../assistant/server/chat/usage";
import type { ModelMeter } from "../../models/server/meter";
import { parseModelId } from "../../models/shared/models";
import type { BotMessage, BotSendEvent, TurnStatus } from "../shared/turn";
import { findBot, staleTurnMs, textParts, toBotMessage, turnTimeLimitMs } from "./store";

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
 * Saves the user's Message and starts the Turn it begins. Checks run before anything is written,
 * and a refusal throws an RPC error before the stream starts. The returned stream yields the saved
 * user Message, each SendToUser Message as it is appended, then `turnEnded`.
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
  // before the user's Message is saved.
  if (!(await call.meter.mayRun()).ok) {
    throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
  }

  const now = new Date();
  const turnId = uuidv7();
  const userMessage = await deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, so two sends can't both find no Turn running.
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, found.conversationId))
      .for("update");
    const running = await tx
      .select({ id: botTurn.id, startedAt: botTurn.startedAt })
      .from(botTurn)
      .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")));
    if (running.some((turn) => now.getTime() - turn.startedAt.getTime() < staleTurnMs)) {
      throw rpcError("CONFLICT", "error.turnRunning", "A Turn is still running for this Bot");
    }
    if (running.length > 0) {
      await tx
        .update(botTurn)
        .set({ status: "error", error: "interrupted", endedAt: now })
        .where(
          inArray(
            botTurn.id,
            running.map((turn) => turn.id),
          ),
        );
    }
    const row = await appendMessage(tx, found.conversationId, {
      role: "user",
      parts: textParts(text),
      status: "complete",
      createdAt: now,
    });
    // A ms after its Message, so the replayed history puts the Turn after the Message it answers.
    await tx
      .insert(botTurn)
      .values({ id: turnId, botId, status: "running", startedAt: new Date(now.getTime() + 1) });
    return toBotMessage(row);
  });

  return started(
    runTurn(deps, {
      conversationId: found.conversationId,
      turnId,
      userMessage,
      provider: parseModelId(found.model)?.provider ?? "",
      meter: call.meter,
      // Inside the Turn, so a failure here ends it `error` instead of leaving it running.
      prepare: async () => ({
        input: await modelInput(deps, { conversationId: found.conversationId, botId, turnId }),
        adapter: deps
          .plugin("models")
          .adapterFor(found.model, call.credentials, { maxOutputTokens: call.maxOutputTokens }),
      }),
      signal,
    }),
  );
}

/**
 * The stream, run up to its first event. A generator left before its first `next()` never runs its
 * body, so its `finally` wouldn't end the Turn's row; once started, `return()` runs it. The first
 * event is held and given to the first `next()`.
 */
async function started<T>(stream: AsyncGenerator<T>): Promise<AsyncGenerator<T>> {
  let first: IteratorResult<T> | undefined = await stream.next();
  const resumed: AsyncGenerator<T> = {
    next: (...args) => {
      const held = first;
      first = undefined;
      return held ? Promise.resolve(held) : stream.next(...args);
    },
    return: (value) => stream.return(value),
    throw: (error) => stream.throw(error),
    [Symbol.asyncIterator]: () => resumed,
    [Symbol.asyncDispose]: () => stream[Symbol.asyncDispose](),
  };
  return resumed;
}

/**
 * The Turn's model input: each user Message as a user turn and each earlier Turn as its transcript,
 * in order. The Bot's sent Messages are not replayed as text: the transcripts hold them as
 * SendToUser calls.
 */
async function modelInput(
  deps: BotSdkContext,
  { conversationId, botId, turnId }: { conversationId: string; botId: string; turnId: string },
): Promise<ModelMessage[]> {
  const [users, turns] = await Promise.all([
    deps.db
      .select({ parts: message.parts, createdAt: message.createdAt })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.role, "user")))
      .orderBy(asc(message.createdAt), asc(message.id)),
    deps.db
      .select({ transcript: botTurn.transcript, startedAt: botTurn.startedAt })
      .from(botTurn)
      .where(and(eq(botTurn.botId, botId), ne(botTurn.id, turnId)))
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

/**
 * The Turn's loop (slide 2): `chat()` with SendToUser as its only tool, streaming each sent Message
 * as it is appended. A Step with no tool call ends the Turn quiet; the Step and time limits end it
 * `error`. The Turn's row is ended, with its transcript and usage, however the loop stops, and the
 * usage is recorded against the Quota on Host credentials.
 */
async function* runTurn(
  deps: BotSdkContext,
  {
    conversationId,
    turnId,
    userMessage,
    provider,
    meter,
    prepare,
    signal,
  }: {
    conversationId: string;
    turnId: string;
    userMessage: BotMessage;
    /** The Model's Provider, for reading the usage it reports. */
    provider: string;
    /** The Model call's meter: on Host credentials it records the Turn in `chat.usage` (ADR 0007). */
    meter: ModelMeter;
    /** The Turn's model input and the adapter it calls. */
    prepare: () => Promise<{ input: ModelMessage[]; adapter: AnyTextAdapter }>;
    signal?: AbortSignal;
  },
): AsyncGenerator<BotSendEvent> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeLimit = setTimeout(() => {
    // A Turn that was stopped but hasn't ended yet stays stopped.
    if (abortController.signal.aborted) return;
    timedOut = true;
    abortController.abort();
  }, turnTimeLimitMs);
  /** The Messages SendToUser appended that the stream hasn't yielded yet, in order. */
  const sent: BotMessage[] = [];
  let endTurn = false;
  let stepLimit = false;
  let engine: ChatMiddlewareContext | undefined;
  let input: ModelMessage[] = [];
  /** Each Step's `RUN_FINISHED`, which carries the usage the Provider reported for it. */
  const finishedSteps: StreamChunk[] = [];
  let error: string | undefined;
  let finished = false;

  const sendToUser = sendToUserDefinition.server(async ({ text, endTurn: last }) => {
    if (!text.trim()) return { error: emptyTextError };
    const row = await deps.db.transaction((tx) =>
      appendMessage(tx, conversationId, {
        role: "assistant",
        parts: textParts(text),
        status: "complete",
        createdAt: new Date(),
      }),
    );
    sent.push(toBotMessage(row));
    if (last) endTurn = true;
    return { sent: true };
  });

  let status: TurnStatus = "stopped";
  try {
    yield { type: "message", message: userMessage };
    const prepared = await prepare();
    input = prepared.input;
    const stream = chat({
      adapter: prepared.adapter,
      messages: input,
      systemPrompts: [botSystemPrompt],
      tools: [sendToUser],
      // One call at a time, so several sends of one Step are appended in the order they were made.
      toolExecution: "sequential",
      abortController,
      // The Step limit is the middleware's, so the engine's default limit doesn't end the Turn first.
      agentLoopStrategy: () => true,
      middleware: [
        {
          name: "bot-turn",
          onStart: (ctx) => {
            engine = ctx;
          },
          onShouldContinue: (_ctx, state) => {
            // Any `endTurn: true` in the Step ends the Turn with no further model call.
            if (endTurn) return false;
            // A Step that called a tool would go on to another; past the limit, the Turn ends.
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
      if (chunk.type === EventType.RUN_FINISHED) finishedSteps.push(chunk);
      yield* drain(sent);
    }
    // The loop is over: a client slow to read the last Messages doesn't make the Turn time out.
    clearTimeout(timeLimit);
    yield* drain(sent);
    finished = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeLimit);
    signal?.removeEventListener("abort", onAbort);
    // A stream left before its end (the client went away) stops the Turn.
    if (!finished) abortController.abort();
    const ending = endingOf({
      timedOut,
      stepLimit,
      // An abort wins over an error: the adapter often reports the cancelled request as one.
      stopped: abortController.signal.aborted,
      error,
      finished,
    });
    status = ending.status;
    const transcript = answeredCalls(engine ? engine.messages.slice(engine.messageCount) : []);
    // What the Provider reported for the Steps that finished, so a long Turn that hit a limit is
    // billed for each of its Steps; an estimate only when no Step reported any.
    const reported = reportedUsageOf(provider, finishedSteps);
    const usage = engine
      ? deps.plugin("models").messageUsage(reported.usage, {
          promptCharacters: promptCharactersOf(input),
          parts: transcript.flatMap(textOf),
        })
      : null;
    await deps.db
      .update(botTurn)
      .set({ status, error: ending.error, usage, endedAt: new Date(), transcript })
      .where(eq(botTurn.id, turnId));
    if (usage) {
      await meter.record({
        kind: "turn",
        usage,
        reportedCost: reported.cost,
      });
    }
  }
  yield { type: "turnEnded", status };
}

/** How a Turn ended, and why when it failed: a limit's code or the Provider's error. */
function endingOf({
  timedOut,
  stepLimit,
  stopped,
  error,
  finished,
}: {
  timedOut: boolean;
  stepLimit: boolean;
  stopped: boolean;
  error: string | undefined;
  finished: boolean;
}): { status: TurnStatus; error: string | null } {
  if (timedOut) return { status: "error", error: "timed_out" };
  if (stopped) return { status: "stopped", error: null };
  if (error !== undefined) return { status: "error", error };
  if (stepLimit) return { status: "error", error: "step_limit" };
  return finished ? { status: "complete", error: null } : { status: "stopped", error: null };
}

/** A transcript entry's text for a usage estimate: the Model's own text and its tool calls. */
function textOf(entry: ModelMessage): { type: "text"; text: string }[] {
  if (entry.role !== "assistant") return [];
  const content = typeof entry.content === "string" ? entry.content : "";
  const calls = (entry.toolCalls ?? []).map((call) => call.function.arguments).join("");
  return [{ type: "text", text: content + calls }];
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

/** Yields and removes the sent Messages waiting in `sent`, oldest first. */
function* drain(sent: BotMessage[]): Generator<BotSendEvent> {
  for (let next = sent.shift(); next; next = sent.shift()) yield { type: "message", message: next };
}
