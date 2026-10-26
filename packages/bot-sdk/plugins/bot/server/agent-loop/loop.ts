import {
  type AnyServerTool,
  type AnyTextAdapter,
  type ChatMiddlewareContext,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";

import type { PromptHash } from "../../../../core/server/chat/hooks";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  withCacheControl,
  addUsage,
  promptCharactersOf,
  reportedUsageOf,
} from "../../../models/server/internal";

import type { ModelUsage } from "../../../models/server/internal";
import { parseModelId } from "../../../models/shared/models";
import { modelsDevSnapshot } from "../../../models/shared/models-snapshot";
import type { MessageUsage } from "../../../models/shared/usage";
import {
  type ComputerHandle,
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../../computer/server/internal";
import { type WorkflowContext, WorkflowYieldedError } from "../../../runner/server/internal";
import {
  capOutput,
  capResult,
  isLong,
  computerOf,
  computerOperationError,
  computerToolDefinitions,
  computerUnavailableError,
  defaultShellTimeoutSeconds,
  editDefinition,
  editTool,
  type FileToolOptions,
  interruptedShellError,
  listDefinition,
  listTool,
  readDefinition,
  readTool,
  rebuiltNote,
  shellDefinition,
  shellStartActivity,
  shellToolName,
  spillPath,
  timedOutHint,
  writeDefinition,
  writeTool,
} from "./computer-tools";
import {
  resolvePath,
  pruneScreenshots,
  resolveImageRefs,
  computerRebuildSeenAt,
  markComputerRebuildSeen,
} from "../conversation";

import { type LoopPromptStart, type PreviousCall, promptHashesOf } from "./prompt-hashes";
import {
  blockedError,
  type ReviewAsk,
  type ReviewSource,
  reviewToolCall,
  type DecryptedSecrets,
  loadSecretValues,
  maskResult,
  maskedFormsOf,
  secretMasker,
  unknownSecretError,
} from "../safety";

import { isReservedSecretName, reservedSecretNameMessage } from "../../shared/secret";

/**
 * The final message of a summary call (slide 34): sent after the Prompt start and history, so the
 * call reads the cache. The Bot's last Messages to the user are added word for word afterwards.
 */
export const summarizeInstruction =
  "(A note from the system, not from the user.) Your context is nearly full, so it will be " +
  "replaced by a summary. Write that summary now, as plain text and no tool call: what the user " +
  "has asked for, what you have found and done so far, what is still left to do, and every fact, " +
  "name, number, file path and decision you will need to carry on. Your last messages to the user " +
  "are kept word for word, so you need not repeat them.";

/** The note after a Turn's input once it summarized mid-Turn: its earlier Steps are in the Summary. */
export const midTurnNote = "[Your earlier work on this Turn is in the Summary.]";

/** The optional parts of a `computerCall`, each described there. */
export type ComputerCallOptions = {
  capped?: boolean;
  reviewed?: Record<string, unknown>;
  unless?: () => Promise<{ error: string } | null>;
  ask?: ReviewAsk;
};

/** What a loop lends the tools of whoever runs it: a Turn today, a Helper next. */
export type LoopKit = {
  /**
   * A database write of the loop's, as tool call `toolCallId` when it is one: it commits with its
   * Checkpoint, so it happens once across a crash, and runs only live, like a tool's activity. A
   * tool call's result over the long-output limit is recorded, and returned, as its cut text
   * (`capResult`), cut in a second activity once the write commits, so the save is outside its
   * transaction; with no `toolCallId` (the loop's own reads, such as setup's), it is never cut.
   */
  liveActivity: <T>(
    name: string,
    toolCallId: string | undefined,
    write: (tx: Transaction) => Promise<T>,
  ) => Promise<T>;
  /**
   * A live call outside the database, as tool call `toolCallId`, then a write with its result: `run`
   * is one activity with no transaction, re-run after a crash before its Checkpoint is saved, and
   * `write` is a second activity whose writes commit with its own Checkpoint, so they happen once
   * (none without `write`, for a read with nothing to write, such as setup's).
   * Both run only live; a replay returns `run`'s recorded result. A tool call's result over the
   * long-output limit is recorded, and returned, as its cut text (`capResult`), as for
   * `liveActivity`. `reviewed` is the call's input, given only for a call Auto-review checks (a
   * Connector tool's): it is reviewed first, as `computerCall`'s is, and a block is its result,
   * with neither `run` nor `write` called.
   */
  liveRequest: <T>(
    name: string,
    toolCallId: string | undefined,
    run: () => Promise<T>,
    write?: (tx: Transaction, result: T | string) => Promise<void>,
    reviewed?: Record<string, unknown>,
  ) => Promise<T | string | { error: string }>;
  /** The Computer's tools: Shell, then the file tools Read, Write, Edit and List. */
  computerTools: AnyServerTool[];
  /** Aborts on a Stop or the loop's time limit. */
  signal: AbortSignal;
  /**
   * A Computer tool call of the loop's, as tool call `toolCallId`: one activity, re-run after a
   * crash, that `operate`s live on the Computer. A failed wake or operation is its result, and
   * after a rebuild the Bot wasn't told of, the result carries the rebuilt note. A tool call's result
   * over the long-output limit is recorded as its cut text (`capResult`), unless `capped` is false:
   * for a tool that keeps its own result short, such as `read`'s pages. A call with no
   * `toolCallId` (setup's reads, such as the memory snapshot) is never cut: the Model never sees
   * its result as is. `reviewed` is the tool's input, given only for a tool Auto-review checks
   * (spec #691): the reviewer reads it first, and a block is the call's result, with nothing run.
   * `unless`, asked before the review in a recorded activity, is an error that stops the call
   * with no review, or `null` to go on. `ask` is for a call the user always decides: it skips
   * Auto-review for an Approval with that reason and summary, and runs only on a yes. `operate` gets `mask`, which masks the user's Secrets
   * in a text: for one it cuts down itself, before the cut. Its result is masked all the same.
   */
  computerCall: <T extends object>(
    name: string,
    toolCallId: string | undefined,
    operate: (
      computer: ComputerHandle,
      live: FileToolOptions,
      mask: (text: string) => string,
    ) => Promise<T>,
    options?: ComputerCallOptions,
  ) => Promise<T | { error: string }>;
};

/**
 * What a loop's `setup` hands it: the system prompts, or the Prompt start a Turn sends in their
 * place, the tools, and what ends it early.
 */
export type LoopSetup = {
  tools: AnyServerTool[];
  /** Whether a tool call of the Step asked to end the loop with no further model call. */
  ended?: () => boolean;
  /**
   * The newest message, when setup builds it (a Turn's, which holds Change notes read in setup):
   * it follows `input` in what the loop sends.
   */
  newest?: ModelMessage[];
} & (
  | { systemPrompts: string[]; promptStart?: never }
  | {
      /**
       * Sent on every model call: its system blocks and its tool definitions in place of the live
       * tools' own, and its first message before the input. Each call records its section hashes.
       */
      promptStart: LoopPromptStart;
      systemPrompts?: never;
      /** The messages sent between the first message and the loop's input. */
      history?: ModelMessage[];
      /**
       * Lets the loop summarize mid-Turn (slide 34): before a Step whose previous Step's input
       * passed `summaryThreshold` of the model's context window. `write` stores the Summary's
       * `prose` in `tx` with a new Prompt start and returns its id, which `load` reads.
       */
      summarize?: {
        write: (tx: Transaction, prose: string) => Promise<string>;
        load: (id: string) => Promise<LoopPromptStart>;
      };
    }
);

/** The share of the model's context window past which a loop summarizes before its next Step. */
export const summaryThreshold = 0.75;

export type LoopOptions = {
  /** Whose Model the loop calls and whose Computer it works. */
  owner: { userId: string; botId: string; model: string };
  /** What its model calls are billed as. */
  usageKind: ModelUsage["kind"];
  /** The Turn or Helper its model calls are recorded for. */
  sourceId: string;
  /** The model input before the loop's own Steps. */
  input: ModelMessage[];
  /** When the loop started: its time limit counts from here. */
  startedAt: Date;
  /** The most Steps it may take; a Step past it that would call a tool ends it `stepLimit`. */
  stepLimit: number;
  /** The wall-clock limit from `startedAt`. */
  timeLimitMs: number;
  /**
   * The note added as a user turn when a Step ends in plain text and no tool call, for one more
   * Step, at most once, when a Step is left under the limit. With none, such a Step ends the loop.
   */
  plainTextReminder?: string;
  /**
   * Builds the loop's tools from `kit`, and may run activities first: it runs inside the loop, so
   * its activities replay in order, and a throw that recorded nothing is a failure to retry.
   */
  setup: (kit: LoopKit) => Promise<LoopSetup>;
  /** Whether the Model sees images, when the caller already asked; else the loop asks, once. */
  seesImages?: () => Promise<boolean>;
  /** The attempt's signal: the live call stops when it aborts. With none, there is no time limit. */
  attempt?: AbortSignal;
  /**
   * Whether a rebuild the loop's results tell counts as told to the Bot (true by default). A
   * Helper's loop tells only its own context, so the Bot still hears of it in its next Turn.
   */
  tellsBot?: boolean;
  /**
   * Reads what has arrived for the loop since its last model call, as user turns added before the
   * next one, in an `inbox` activity: a replay reads the recorded turns (a Helper's, #566).
   */
  inbox?: (tx: Transaction) => Promise<string[]>;
  /** Runs after each `inbox` activity, once its Checkpoint has committed (and on its replay). */
  afterInbox?: () => Promise<void>;
  /**
   * Where the loop's reviewed calls come from (a Turn's or a Helper's): each `shell` call, and each
   * `computerCall` given its input to review, gets Auto-review before it runs. With none, nothing
   * is reviewed.
   */
  review?: ReviewSource;
};

/** What a played loop came to. `failure` is an activity that threw, which recorded nothing. */
export type LoopResult = {
  timedOut: boolean;
  stepLimit: boolean;
  stopped: boolean;
  error: string | undefined;
  finished: boolean;
  transcript: ModelMessage[];
  usage: MessageUsage | null;
  /** The input its last model call reported, or estimated: what queues a Summary while away. */
  lastInput: number | undefined;
  failure?: unknown;
};

/**
 * What one model call recorded: its chunks, what it bills (`null` for nothing) and, with a Prompt
 * start, the hash of each section it sent.
 */
type RecordedModelCall = {
  chunks: StreamChunk[];
  usage: { usage: MessageUsage; reportedCost?: number } | null;
  hashes?: PromptHash[];
};

/** The Model's own failure in a live model call, as opposed to a failure to save its Checkpoint. */
class ModelCallError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/**
 * Records one model call's usage against the Quota, in its bill's Checkpoint transaction. Returns
 * the `onUsage` firing, for once that transaction has committed.
 */
type ModelCallRecorder = (
  tx: Transaction,
  usage: MessageUsage,
  reportedCost: number | undefined,
  promptHashes: PromptHash[] | undefined,
  kind?: ModelUsage["kind"],
) => Promise<() => void>;

/**
 * The one-activity-per-call loop (slide 2) that a Turn runs: `chat()` with the tools `setup`
 * gives, each model call and each tool call an activity of the workflow `ctx` (ADR 0011, the #482
 * amendment). A recorded call returns its result without running; past the history, calls run for
 * real. A model call's usage commits with its `bill` Checkpoint, so it is billed once. A Step with
 * no tool call ends the loop, except as `plainTextReminder` says; the Step and time limits end it
 * `stepLimit` and `timedOut`.
 */
export async function runLoop(
  deps: BotSdkContext,
  ctx: WorkflowContext<Transaction>,
  options: LoopOptions,
): Promise<LoopResult> {
  const { owner, attempt, startedAt, stepLimit: limit, timeLimitMs } = options;
  const provider = parseModelId(owner.model)?.provider ?? "";
  // A Turn's calls are its Bot's thread; a Helper's are its own. The cache key names it too.
  const threadId = options.usageKind === "helper" ? options.sourceId : owner.botId;
  const cacheKey = `${options.usageKind === "helper" ? "helper" : "bot"}:${threadId}`;
  const abortController = new AbortController();
  const onAttemptAbort = () => abortController.abort(attempt?.reason);
  if (attempt?.aborted) onAttemptAbort();
  attempt?.addEventListener("abort", onAttemptAbort, { once: true });
  let timedOut = false;
  const timeUp = () => {
    // A loop that was stopped but hasn't ended yet stays stopped.
    if (abortController.signal.aborted) return;
    timedOut = true;
    abortController.abort();
  };
  // Wall clock from the start. It cuts off only a live model call, never the replay of the
  // recorded ones: past the limit, the next live call ends the loop. A replay with no attempt (the
  // job's `onFailed`) has no limit.
  let expired = false;
  let inLiveCall = false;
  const timeLeftMs = () => timeLimitMs - (deps.clock().getTime() - startedAt.getTime());
  const timeLimit = attempt
    ? setTimeout(
        () => {
          expired = true;
          if (inLiveCall) timeUp();
        },
        Math.max(0, timeLeftMs()),
      )
    : undefined;
  let stepLimit = false;
  /** The loop's Steps so far, recorded or live: one per model call. */
  let steps = 0;
  /** What each recorded model call billed. */
  const billed: MessageUsage[] = [];
  /** The tool calls whose activity threw: they recorded nothing, so they stay unanswered. */
  const unanswered = new Set<string>();
  let failure: unknown;
  let error: string | undefined;
  let finished = false;

  const seesImages = options.seesImages ?? seesImagesOnce(deps, owner);

  /**
   * The images the last model call read from the blob store, by key: each is read once while the
   * history keeps it, not on every call. One the next call doesn't send is let go.
   */
  let imageReads = new Map<string, Promise<Uint8Array | null>>();
  let kept = new Map<string, Promise<Uint8Array | null>>();
  const imageStore = {
    get: (key: string) => {
      let read = imageReads.get(key);
      if (read) kept.set(key, read);
      if (!read) {
        read = deps.blobStore.get(key);
        imageReads.set(key, read);
        kept.set(key, read);
        // A failed read is retried on the next call, like the Checkpoint it fails.
        read.catch(() => {
          imageReads.delete(key);
          kept.delete(key);
        });
      }
      return read;
    },
  };

  /** The Model's call, made once: the credentials and the adapter are only needed for a live call. */
  let live: Promise<{ adapter: AnyTextAdapter; record: ModelCallRecorder }> | undefined;
  const liveCall = () =>
    (live ??= (async () => {
      const models = deps.models;
      const call = await models.resolveModelCall(owner.userId, owner.model);
      if (!call) throw new Error(`"${owner.model}" is not an available Model`);
      // On the user's own key or plan, a call is still recorded, at cost 0, so its cache use shows.
      const meter = call.meter.onHost
        ? call.meter
        : models.freeModelMeter(owner.userId, owner.model);
      return {
        adapter: models.adapterForCall(owner.model, call),
        record: (tx, usage, reportedCost, promptHashes, kind = options.usageKind) =>
          meter.recordIn(tx, {
            kind,
            usage,
            reportedCost,
            sourceId: options.sourceId,
            promptHashes,
          }),
      };
    })());

  /** The Prompt start the setup gave, if any. */
  let promptStart: LoopPromptStart | undefined;
  /** The model call before the next one, once known: `null` when there was none. */
  let previousCall: PreviousCall | null | undefined;
  /** The input the last model call reported, until a Summary: what the next Step checks. */
  let lastInput: number | undefined;
  /** The input the last model call reported, a Summary or not. */
  let lastStepInput: number | undefined;
  /** The options of the last model call, which a summary call sends again with its instruction. */
  let lastChatOptions: TextOptions | undefined;
  /**
   * After a mid-Turn Summary, where its note sits in the loop's messages: the calls after it send
   * the new first message, the loop's own input, then the messages from the note on.
   */
  let summarizedAt: number | undefined;
  /** The loop's own input, then the newest message setup built: what a Summary's calls re-send. */
  let newest: ModelMessage[] = [];
  /**
   * An activity that bills a model call in its Checkpoint's transaction: what `write` hands
   * `onCommit` fires once that has committed, and never on a replay.
   */
  const billing = async <T>(
    name: string,
    write: (tx: Transaction, onCommit: (fire: () => void) => void) => Promise<T>,
  ): Promise<T> => {
    let fire: (() => void) | undefined;
    let result: T;
    try {
      result = await ctx.step(name, (tx) =>
        write(tx, (onUsage) => {
          fire = onUsage;
        }),
      );
    } catch (caught) {
      // A yield is thrown once the Checkpoint has committed: its next attempt replays it, so it
      // fires now or never.
      if (caught instanceof WorkflowYieldedError) fire?.();
      throw caught;
    }
    fire?.();
    return result;
  };
  /** What a model call sends of the loop's `messages`, its first message first. */
  const sendable = (messages: ModelMessage[]): ModelMessage[] =>
    promptStart && summarizedAt !== undefined
      ? [
          { role: "user", content: promptStart.firstMessage },
          ...newest,
          ...messages.slice(summarizedAt),
        ]
      : messages;
  /**
   * A model call's options as sent: with a Prompt start, its stored tool definitions (never the
   * live tools' own) and its system blocks, and the messages as `sendable` gives them. Only the
   * newest screenshots stay in the messages (`pruneScreenshots`), so the hashes cover what is
   * sent. The window slides: each new screenshot replaces the oldest one kept, so the cache is
   * written again from that message on. Between two screenshots, every call sends the same bytes.
   */
  const sentOptions = (chatOptions: TextOptions): TextOptions => {
    const sent = promptStart
      ? {
          ...chatOptions,
          tools: promptStart.tools as TextOptions["tools"],
          systemPrompts: promptStart.system.map((block) => block.text),
          messages: sendable(chatOptions.messages as ModelMessage[]),
        }
      : chatOptions;
    return { ...sent, messages: pruneScreenshots(sent.messages as ModelMessage[]) };
  };

  /**
   * A live model call of `sent`, inside a model call's activity: its chunks, without the raw events.
   * The Model's own failure throws a `ModelCallError`.
   */
  const liveChunks = async (sent: TextOptions): Promise<StreamChunk[]> => {
    // Read off the clock too: a timer that is due may not have fired yet.
    if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
    abortController.signal.throwIfAborted();
    // The screenshots `sentOptions` kept go to the Model, read from the blob store now: the
    // transcript and the Checkpoints hold their refs (#608). Outside the Model's own failure, so a
    // failed read is retried like a Checkpoint that failed to save.
    const pruned = {
      ...sent,
      messages: await resolveImageRefs(imageStore, sent.messages as ModelMessage[], {
        seesImages: await seesImages(),
      }),
    };
    [imageReads, kept] = [kept, new Map()];
    const chunks: StreamChunk[] = [];
    inLiveCall = true;
    try {
      const { adapter } = await liveCall();
      // The cache controls of the Model's Provider: the Bot's key, or its Helper's.
      const cached = withCacheControl(provider, cacheKey, pruned);
      for await (const chunk of adapter.chatStream(cached)) {
        chunks.push(withoutRaw(chunk));
      }
    } catch (caught) {
      throw new ModelCallError(caught);
    } finally {
      inLiveCall = false;
    }
    // A call cut off before its end records nothing and bills nothing; a resume calls it again.
    abortController.signal.throwIfAborted();
    return chunks;
  };

  // The model call as an activity: replayed, it plays the recorded chunks without calling the Model.
  // The call runs outside a transaction; its bill is the next activity, written in that activity's
  // Checkpoint transaction, so it commits once.
  const durableAdapter = {
    kind: "text",
    name: provider,
    model: parseModelId(owner.model)?.modelId ?? owner.model,
    chatStream: async function* (chatOptions: TextOptions) {
      steps += 1;
      lastChatOptions = chatOptions;
      let recorded: RecordedModelCall;
      try {
        recorded = await ctx.step("model", async (): Promise<RecordedModelCall> => {
          const sent = sentOptions(chatOptions);
          let hashes: PromptHash[] | undefined;
          if (promptStart) {
            if (previousCall === undefined)
              previousCall = (await promptStart.previousCall()) ?? null;
            hashes = promptHashesOf(
              promptStart,
              {
                tools: sent.tools ?? [],
                systemPrompts: sent.systemPrompts ?? [],
                messages: sent.messages as ModelMessage[],
              },
              previousCall ?? undefined,
            );
          }
          const chunks = await liveChunks(sent);
          const usage = callUsage(deps, chunks, sent.messages as ModelMessage[]);
          return { chunks, usage: usage ?? null, ...(hashes ? { hashes } : {}) };
        });
        if (promptStart && recorded.hashes) {
          previousCall = { promptStartId: promptStart.id, hashes: recorded.hashes };
        }
        lastInput = recorded.usage?.usage.input;
        lastStepInput = lastInput;
        const bill = recorded.usage;
        if (bill) {
          await billing("bill", async (tx, onCommit) => {
            const { record } = await liveCall();
            onCommit(await record(tx, bill.usage, bill.reportedCost, recorded.hashes));
            return null;
          });
          billed.push(bill.usage);
        }
      } catch (caught) {
        // The Model's own failure ends the loop `error`, as `chat()` reports it.
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

  /** How the setup lets the loop summarize mid-Turn, if it does. */
  let summarize: Extract<LoopSetup, { promptStart: LoopPromptStart }>["summarize"];
  const contextWindow = modelsDevSnapshot[owner.model]?.contextWindow ?? null;
  /**
   * Before a Step, with `all` the messages it would send: when the previous Step's input passed
   * `summaryThreshold` of the context window, a Summary (slide 34). The summary call sends the same
   * Prompt start and history with `summarizeInstruction` after them, as the recorded activity
   * `summary`, so a replay reuses it; its bill and the Summary with its new Prompt start commit in
   * one Checkpoint. The Steps after it send the new Prompt start, the loop's own input, then the
   * messages from the note on. Returns whether it summarized.
   */
  const summarizeIfFull = async (all: ModelMessage[]): Promise<boolean> => {
    if (!summarize || !promptStart || !lastChatOptions || !contextWindow) return false;
    if (lastInput === undefined || lastInput <= summaryThreshold * contextWindow) return false;
    const { write, load } = summarize;
    const sent = sentOptions({ ...lastChatOptions, messages: all });
    const written = await ctx.step(
      "summary",
      async (): Promise<{ prose: string; usage: RecordedModelCall["usage"] }> => {
        const messages: ModelMessage[] = [
          ...(sent.messages as ModelMessage[]),
          { role: "user", content: summarizeInstruction },
        ];
        const chunks = await liveChunks({ ...sent, messages });
        // The Model's own failure ends the loop `error`, as a Step's does: retrying sends the same.
        const failed = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
        if (failed) throw new ModelCallError(new Error(failed.message));
        const prose = chunks
          .map((chunk) => (chunk.type === EventType.TEXT_MESSAGE_CONTENT ? chunk.delta : ""))
          .join("");
        return { prose, usage: callUsage(deps, chunks, messages) };
      },
    );
    // The previous Step's input is checked once: the next Step checks its own.
    lastInput = undefined;
    const id = await billing("summary:write", async (tx, onCommit) => {
      const bill = written.usage;
      if (bill) {
        const { record } = await liveCall();
        onCommit(await record(tx, bill.usage, bill.reportedCost, undefined, "summary"));
      }
      // A reply with no summary (only tool calls, or nothing) is billed but never replaces the
      // context: the Turn carries on as it was.
      return written.prose.trim() ? write(tx, written.prose) : null;
    });
    // The summary call is part of what the Turn cost.
    if (written.usage) billed.push(written.usage.usage);
    if (id === null) return false;
    promptStart = await load(id);
    summarizedAt = all.length;
    return true;
  };

  /**
   * One tool call. A call that throws recorded nothing: it stays unanswered and ends the attempt,
   * and only a throw that no time limit or stop caused is a failure to retry.
   */
  const toolCall = async <T>(toolCallId: string | undefined, call: () => Promise<T>) => {
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
   * past the limit, a resumed loop does nothing more, and never answers a question from long ago.
   */
  const beforeLiveTool = () => {
    if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
    abortController.signal.throwIfAborted();
  };
  let userComputer: ComputerHandle | undefined;
  /**
   * A tool call's result as the Model reads it: over the limit, it is its cut text (typed as the
   * result, since only a long one changes shape), with the rest saved on the Computer when there is
   * one. A result with no `toolCallId` is the loop's own (setup's reads), which callers read as
   * the value it is: it is never cut. The save stops on a Stop or the time limit, and the cut text
   * then says the rest was not saved. Never called in a transaction: a save may wake the Computer.
   */
  const capLong = async <T>(result: T, toolCallId: string | undefined): Promise<T> => {
    if (toolCallId === undefined) return result;
    const computer = deps.computer ? (userComputer ??= computerOf(deps, owner.userId)) : undefined;
    return (await capResult(
      result,
      spillPath(owner.botId, toolCallId),
      computer &&
        ((path, content) => computer.writeFile(path, content, { signal: abortController.signal })),
    )) as T;
  };
  const liveActivity: LoopKit["liveActivity"] = (name, toolCallId, write) =>
    toolCall(toolCallId, async () => {
      const result = await ctx.step(name, async (tx) => {
        beforeLiveTool();
        return await write(tx);
      });
      // A long result is cut in an activity of its own, after the write commits, as
      // `computerCall` cuts outside any transaction: saving the rest may wake the Computer, which
      // must not hold the write's row locks. Its Checkpoint holds the cut form, so a replay never
      // saves again; a short result, or one recorded already cut, adds no activity.
      if (toolCallId === undefined || !isLong(result)) return result;
      return ctx.step(`${name}:cut`, () => capLong(result, toolCallId));
    });
  const liveRequest: LoopKit["liveRequest"] = (name, toolCallId, run, write, reviewed) =>
    toolCall(toolCallId, async () => {
      // Auto-review first: a blocked call never runs.
      const blocked = reviewed && (await review(name, toolCallId, reviewed));
      if (blocked) return blocked;
      const result = await ctx.step(name, async () => {
        beforeLiveTool();
        return capLong(await run(), toolCallId);
      });
      // Not past a limit or a Stop: what `run` did is written, whenever it ran.
      if (!write) return result;
      await ctx.step(`${name}:write`, async (tx) => {
        await write(tx, result);
        return null;
      });
      return result;
    });

  // The latest rebuild of the Computer the Bot was told of, read on its first Computer call
  // (undefined until then), and the one the latest result tells, recorded once it is saved.
  let rebuildSeenAt: Date | null | undefined;
  let telling: Date | undefined;
  /**
   * The Computer's operation for a live tool call. A failed wake, or an operation the provider
   * failed, is the tool's result, unless the loop was stopped or ran out of time meanwhile: then
   * the call stays unanswered. A database failure throws, so the job retries it. After a rebuild
   * the Bot wasn't told of, the result carries the rebuilt note (#553).
   */
  const onComputer = async <T extends object>(
    operate: (computer: ComputerHandle) => Promise<T>,
  ) => {
    const computer = (userComputer ??= computerOf(deps, owner.userId));
    try {
      const result = await operate(computer);
      const rebuild = computer.rebuild();
      if (!rebuild) return result;
      if (rebuildSeenAt === undefined)
        rebuildSeenAt = await computerRebuildSeenAt(deps.db, owner.botId);
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
   * `onComputer` for a live call: the loop's time limit, like a Stop, stops its operations
   * through `live`'s signal, and its commands run no later than `live`'s deadline.
   */
  const onLiveComputer = async <T extends object>(
    operate: (computer: ComputerHandle, live: FileToolOptions) => Promise<T>,
  ) => {
    inLiveCall = true;
    try {
      return await onComputer((computer) =>
        operate(computer, {
          deadline: new Date(startedAt.getTime() + timeLimitMs),
          signal: abortController.signal,
        }),
      );
    } finally {
      inLiveCall = false;
    }
  };
  /**
   * After a Computer tool's Checkpoint is saved: the rebuild its result told is recorded as told.
   * A crash before then tells it again in the retried attempt rather than never.
   */
  const recordTold = async <T>(result: T): Promise<T> => {
    if (telling) {
      if (options.tellsBot !== false) await markComputerRebuildSeen(deps.db, owner.botId, telling);
      rebuildSeenAt = telling;
      telling = undefined;
    }
    return result;
  };
  /**
   * Auto-review of a reviewed tool's call, before it runs: the error the Model gets for a block, or
   * `null` to run it. A loop with no `review` source reviews nothing.
   */
  const review = async (
    tool: string,
    toolCallId: string | undefined,
    input: Record<string, unknown>,
    ask?: ReviewAsk,
  ): Promise<{ error: string } | null> => {
    // A loop with no review source has no one to ask: what the user always decides is refused.
    if (!options.review) return ask ? { error: blockedError(ask.reason) } : null;
    // The live review is a model call: the loop's time limit cuts it off, as a Stop does.
    return reviewToolCall(
      deps,
      {
        activity: ctx.step,
        billing,
        now: ctx.now,
        beforeLive: () => {
          beforeLiveTool();
          inLiveCall = true;
        },
        signal: abortController.signal,
        usageOf: (chunks, sent) => callUsage(deps, chunks, sent),
      },
      { owner, source: options.review, toolCallId, tool, input, ask },
    ).finally(() => {
      inLiveCall = false;
    });
  };
  /** The Secrets this loop has decrypted: each call reads the rows, and decrypts only new ones. */
  const decrypted: DecryptedSecrets = new Map();
  const shell = shellDefinition.server((input, context) =>
    toolCall(context?.toolCallId, async () => {
      const { command, cwd, timeoutSeconds, secrets } = input;
      // Auto-review first: a blocked command never starts.
      const blocked = await review(shellToolName, context?.toolCallId, input);
      if (blocked) return blocked;
      // The start marker: a resumed loop that replays it with no result never runs the command
      // again, since it may have partly run. A yield waits for the command's own Checkpoint, so
      // the marker never stands for a command that didn't start. No transaction: the command runs
      // on the Computer, not in the database.
      let startedHere = false;
      await ctx.step(
        shellStartActivity,
        async () => {
          beforeLiveTool();
          startedHere = true;
          return null;
        },
        { yields: false },
      );
      const result = await ctx.step(shellToolName, async () => {
        beforeLiveTool();
        if (!startedHere) return { error: interruptedShellError };
        // The user's Secrets, read for this one command: it gets only the ones it names, and the
        // result is masked of all of them.
        const values = await loadSecretValues(deps, owner.userId, decrypted);
        const unknown = (secrets ?? []).filter((name) => !values.has(name));
        if (unknown.length > 0) return { error: unknownSecretError(unknown, values.keys()) };
        // Defence in depth: a reserved name can't be saved, but one that was would not be set.
        const reserved = (secrets ?? []).filter(isReservedSecretName);
        if (reserved.length > 0) return { error: reservedSecretNameMessage(reserved.join(", ")) };
        const secretValues = [...values.values()];
        const mask = secretMasker(secretValues);
        const envs = Object.fromEntries((secrets ?? []).map((name) => [name, values.get(name)!]));
        return onLiveComputer(async (computer, live) => {
          const output = await computer.run(command, {
            ...live,
            cwd: resolvePath(owner.botId, cwd),
            timeoutMs: (timeoutSeconds ?? defaultShellTimeoutSeconds) * 1000,
            ...(secrets?.length && { envs }),
            ...(secretValues.length > 0 && { redact: maskedFormsOf(secretValues) }),
          });
          // Masked before the output is cut down to its ends, so a value is never half kept by the cut.
          const result = {
            ...output,
            stdout: mask(output.stdout),
            stderr: mask(output.stderr),
          };
          // The cap is applied here, so the Checkpoint holds only the truncated form.
          const capped = await capOutput(
            result,
            spillPath(owner.botId, context?.toolCallId ?? uuidv7()),
            computer.writeFile,
          );
          return "timedOut" in capped ? { ...capped, hint: timedOutHint } : capped;
        });
      });
      return recordTold(result);
    }),
  );
  const computerCall: LoopKit["computerCall"] = (
    name,
    toolCallId,
    operate,
    { capped: cap = true, reviewed, unless, ask } = {},
  ) =>
    toolCall(toolCallId, async () => {
      // A call that can't run is told so before its review, so it never waits for an Approval.
      if (unless) {
        const refused = await ctx.step(`${name}:unless`, async () => {
          beforeLiveTool();
          return unless();
        });
        if (refused) return refused;
      }
      // Auto-review first: a blocked call never reaches the Computer.
      const blocked = reviewed && (await review(name, toolCallId, reviewed, ask));
      if (blocked) return blocked;
      return recordTold(
        await ctx.step(name, async () => {
          beforeLiveTool();
          // A Computer tool's result may hold a Secret's value (a file, a page): masked, like `shell`.
          const values = [...(await loadSecretValues(deps, owner.userId, decrypted)).values()];
          const mask = secretMasker(values);
          const result = maskResult(
            await onLiveComputer((computer, live) => operate(computer, live, mask)),
            mask,
          );
          // Cut inside the activity, so the Checkpoint holds only the cut form. A rebuilt note
          // is the result's last field, so it stays in the cut text's end.
          return cap ? await capLong(result, toolCallId) : result;
        }),
      );
    });
  /** A file tool: one activity, re-run after a crash, and a live call like `shell`'s. */
  const fileTool =
    <Input, Output extends object>(
      name: string,
      run: (
        computer: ComputerHandle,
        botId: string,
        input: Input,
        options: FileToolOptions,
        mask: (text: string) => string,
      ) => Promise<Output>,
      cap = true,
    ) =>
    (input: Input, context?: { toolCallId?: string }) =>
      computerCall(
        name,
        context?.toolCallId,
        (computer, live, mask) => run(computer, owner.botId, input, live, mask),
        { capped: cap },
      );
  const computerToolsByName: Record<string, AnyServerTool> = {
    [shellDefinition.name]: shell,
    [readDefinition.name]: readDefinition.server(fileTool("read", readTool, false)),
    [writeDefinition.name]: writeDefinition.server(fileTool("write", writeTool)),
    [editDefinition.name]: editDefinition.server(fileTool("edit", editTool)),
    [listDefinition.name]: listDefinition.server(fileTool("list", listTool)),
  };
  // In the shared order, which an away Summary's Prompt start sends too.
  const computerTools = computerToolDefinitions.map((definition) => {
    const tool = computerToolsByName[definition.name];
    if (!tool) throw new Error(`No implementation for the Computer tool ${definition.name}`);
    return tool;
  });

  /** What the loop's model calls and tool calls added to its input, in order. */
  const messages: ModelMessage[] = [];
  try {
    const setup = await options.setup({
      liveActivity,
      liveRequest,
      computerTools,
      signal: abortController.signal,
      computerCall,
    });
    const { tools, ended = () => false } = setup;
    promptStart = setup.promptStart;
    summarize = setup.promptStart ? setup.summarize : undefined;
    const systemPrompts = setup.promptStart
      ? setup.promptStart.system.map((block) => block.text)
      : setup.systemPrompts;
    newest = [...options.input, ...(setup.newest ?? [])];
    const input: ModelMessage[] = setup.promptStart
      ? [
          { role: "user", content: setup.promptStart.firstMessage },
          ...(setup.history ?? []),
          ...newest,
        ]
      : newest;
    let reminded = false;
    for (;;) {
      let engine: ChatMiddlewareContext | undefined;
      const stream = chat({
        adapter: durableAdapter,
        threadId,
        messages: [...input, ...messages],
        systemPrompts,
        tools,
        // One call at a time, in call order, which is a workflow's identity.
        toolExecution: "sequential",
        abortController,
        // The Step limit is the middleware's, so the engine's default limit doesn't end it first.
        agentLoopStrategy: () => true,
        middleware: [
          {
            name: "bot-turn",
            onStart: (middlewareCtx) => {
              engine = middlewareCtx;
            },
            // Before each model call: what the inbox holds joins the input, and stays in it. Then,
            // past the threshold, a Summary, whose note stays in it too.
            onConfig: async (middlewareCtx, config) => {
              if (middlewareCtx.phase !== "beforeModel") return;
              const { inbox } = options;
              const added: ModelMessage[] = [];
              try {
                if (inbox) {
                  const arrived = await ctx.step("inbox", inbox);
                  await options.afterInbox?.();
                  added.push(...arrived.map((content) => ({ role: "user" as const, content })));
                }
                const all = [...(config.providerMessages ?? config.messages), ...added];
                if (await summarizeIfFull(all)) added.push({ role: "user", content: midTurnNote });
              } catch (caught) {
                // The summary call's Model failure ends the loop `error`, as a Step's does.
                if (caught instanceof ModelCallError) throw caught.cause;
                // It recorded nothing: the job retries it, as for a model call's Checkpoint.
                if (!abortController.signal.aborted) {
                  failure ??= caught;
                  abortController.abort();
                }
                throw caught;
              }
              if (added.length === 0) return;
              return {
                messages: [...config.messages, ...added],
                providerMessages: [...(config.providerMessages ?? config.messages), ...added],
              };
            },
            onShouldContinue: (_middlewareCtx, state) => {
              // A tool call that ends the loop ends it with no further model call.
              if (ended()) return false;
              // A Step that called a tool would go on to another; past the limit, the loop ends.
              // Replay counts the recorded Steps, so a crash can't reset the limit.
              if (state.lastTurnToolCallCount > 0 && steps >= limit) {
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
      if (options.plainTextReminder === undefined) break;
      if (reminded || ended() || stepLimit || error !== undefined) break;
      // With no Step left under the limit, there is no reminder: the loop ends quiet, as before.
      if (abortController.signal.aborted || steps >= limit) break;
      if (!endsInPlainText(messages)) break;
      // Plain text reaches no one: one more Step, with a note that says so (#531). It is rebuilt
      // from the recorded model call on replay, so it needs no Checkpoint of its own.
      reminded = true;
      messages.push({ role: "user", content: options.plainTextReminder });
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
    lastInput: lastStepInput,
    failure,
  };
}

/**
 * What one model call bills: the usage its Provider reported, else an estimate from its input and
 * output. A call that failed with no usage reported bills nothing.
 */
/**
 * Whether `owner`'s Model sees images, asked once and shared by every caller; a failed ask is
 * asked again the next time.
 */
export function seesImagesOnce(
  deps: Pick<BotSdkContext, "models">,
  owner: { userId: string; model: string },
): () => Promise<boolean> {
  let sees: Promise<boolean> | undefined;
  return () =>
    (sees ??= deps.models
      .resolveModel(owner.userId, owner.model)
      .then((model) => model?.images ?? false)
      .catch((caught: unknown) => {
        sees = undefined;
        throw caught;
      }));
}

export function callUsage(
  deps: BotSdkContext,
  chunks: StreamChunk[],
  messages: ModelMessage[],
): { usage: MessageUsage; reportedCost?: number } | null {
  const reported = reportedUsageOf(chunks);
  if (!reported.usage && chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)) return null;
  const output = chunks
    .map((chunk) =>
      chunk.type === EventType.TEXT_MESSAGE_CONTENT || chunk.type === EventType.TOOL_CALL_ARGS
        ? chunk.delta
        : "",
    )
    .join("");
  return {
    usage: deps.models.messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [{ type: "text", text: output }],
    }),
    reportedCost: reported.cost,
  };
}

/** The loop's usage: the sum of what its model calls billed, an estimate if any of them was. */
export function totalUsage(calls: MessageUsage[]): MessageUsage {
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
 * The transcript without tool calls that never got a result (a loop cut off mid-Step), which a
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
