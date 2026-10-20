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

import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { addUsage, promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import type { ModelUsage } from "../../models/server/meter";
import { parseModelId } from "../../models/shared/models";
import type { MessageUsage } from "../../models/shared/usage";
import {
  type ComputerHandle,
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../computer/server/plugin";
import { type WorkflowContext, WorkflowYieldedError } from "../../runner/server/workflow/engine";
import {
  capOutput,
  capResult,
  computerOf,
  computerOperationError,
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
  resolvePath,
  shellDefinition,
  shellStartActivity,
  shellToolName,
  spillPath,
  timedOutHint,
  writeDefinition,
  writeTool,
} from "./computer-tools";
import { pruneScreenshots, resolveScreenshots } from "./desktop-tools";
import { computerRebuildSeenAt, markComputerRebuildSeen } from "./store";

/** What a loop lends the tools of whoever runs it: a Turn today, a Helper next. */
export type LoopKit = {
  /**
   * A database write of the loop's, as tool call `toolCallId` when it is one: it commits with its
   * Checkpoint, so it happens once across a crash, and runs only live, like a tool's activity. A
   * result over the long-output limit is recorded, and returned, as its cut text (`capResult`).
   */
  liveActivity: <T>(
    name: string,
    toolCallId: string | undefined,
    write: (tx: Transaction) => Promise<T>,
  ) => Promise<T>;
  /**
   * A live call outside the database, as tool call `toolCallId`, then a write with its result: `run`
   * is one activity with no transaction, re-run after a crash before its Checkpoint is saved, and
   * `write` is a second activity whose writes commit with its own Checkpoint, so they happen once.
   * Both run only live; a replay returns `run`'s recorded result. A result over the long-output
   * limit is recorded, and returned, as its cut text (`capResult`).
   */
  liveRequest: <T>(
    name: string,
    toolCallId: string | undefined,
    run: () => Promise<T>,
    write: (tx: Transaction, result: T | string) => Promise<void>,
  ) => Promise<T | string>;
  /** The Computer's tools: Shell, then the file tools Read, Write, Edit and List. */
  computerTools: AnyServerTool[];
  /**
   * A Computer tool call of the loop's, as tool call `toolCallId`: one activity, re-run after a
   * crash, that `operate`s live on the Computer. A failed wake or operation is its result, and
   * after a rebuild the Bot wasn't told of, the result carries the rebuilt note. A result over the
   * long-output limit is recorded as its cut text (`capResult`), unless `capped` is false: for a
   * tool that keeps its own result short, such as `read`'s pages.
   */
  computerCall: <T extends object>(
    name: string,
    toolCallId: string | undefined,
    operate: (computer: ComputerHandle, live: FileToolOptions) => Promise<T>,
    capped?: boolean,
  ) => Promise<T | { error: string }>;
};

/** What a loop's `setup` hands it: the system prompts, the tools, and what ends it early. */
export type LoopSetup = {
  systemPrompts: string[];
  tools: AnyServerTool[];
  /** Whether a tool call of the Step asked to end the loop with no further model call. */
  ended?: () => boolean;
};

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
  failure?: unknown;
};

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

  /** The Model's call, made once: the credentials and the adapter are only needed for a live call. */
  let live: Promise<{ adapter: AnyTextAdapter; record: ModelCallRecorder }> | undefined;
  const liveCall = () =>
    (live ??= (async () => {
      const models = deps.plugin("models");
      const call = await models.resolveModelCall(owner.userId, owner.model);
      if (!call) throw new Error(`"${owner.model}" is not an available Model`);
      // On the user's own key or plan, a call is still recorded, at cost 0, so its cache use shows.
      const meter = call.meter.onHost
        ? call.meter
        : models.freeModelMeter(owner.userId, owner.model);
      return {
        adapter: models.adapterForCall(owner.model, call),
        record: (tx, usage, reportedCost) =>
          meter.recordIn(tx, {
            kind: options.usageKind,
            usage,
            reportedCost,
            sourceId: options.sourceId,
          }),
      };
    })());

  // The model call as an activity: replayed, it plays the recorded chunks without calling the Model.
  // The call runs outside a transaction; its bill is the next activity, written in that activity's
  // Checkpoint transaction, so it commits once.
  const durableAdapter = {
    kind: "text",
    name: provider,
    model: parseModelId(owner.model)?.modelId ?? owner.model,
    chatStream: async function* (chatOptions: TextOptions) {
      steps += 1;
      let recorded: RecordedModelCall;
      try {
        recorded = await ctx.activity("model", async (): Promise<RecordedModelCall> => {
          // Read off the clock too: a timer that is due may not have fired yet.
          if (attempt && (expired || timeLeftMs() <= 0)) timeUp();
          abortController.signal.throwIfAborted();
          // Only the newest screenshots go to the Model, read from the blob store now: the
          // transcript and the Checkpoints hold their refs (#608). Outside the Model's own
          // failure, so a failed read is retried like a Checkpoint that failed to save.
          const pruned = {
            ...chatOptions,
            messages: await resolveScreenshots(
              deps.blobStore,
              pruneScreenshots(chatOptions.messages as ModelMessage[]),
            ),
          };
          const chunks: StreamChunk[] = [];
          inLiveCall = true;
          try {
            const { adapter } = await liveCall();
            for await (const chunk of adapter.chatStream(pruned)) {
              chunks.push(withoutRaw(chunk));
            }
          } catch (caught) {
            throw new ModelCallError(caught);
          } finally {
            inLiveCall = false;
          }
          // A call cut off before its end records nothing and bills nothing; a resume calls it again.
          abortController.signal.throwIfAborted();
          const usage = callUsage(deps, provider, chunks, chatOptions.messages as ModelMessage[]);
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
   * A tool result as the Model reads it: over the limit, it is its cut text (typed as the result,
   * since only a long one changes shape), with the rest saved on the Computer when there is one.
   */
  const capLong = async <T>(result: T, toolCallId: string | undefined): Promise<T> => {
    const computer = deps.hasPlugin("computer")
      ? (userComputer ??= computerOf(deps, owner.userId))
      : undefined;
    return (await capResult(
      result,
      spillPath(owner.botId, toolCallId ?? uuidv7()),
      computer && ((path, content) => computer.writeFile(path, content)),
    )) as T;
  };
  const liveActivity: LoopKit["liveActivity"] = (name, toolCallId, write) =>
    toolCall(toolCallId, () =>
      ctx.activity(name, async (tx) => {
        beforeLiveTool();
        return await capLong(await write(tx), toolCallId);
      }),
    );
  const liveRequest: LoopKit["liveRequest"] = (name, toolCallId, run, write) =>
    toolCall(toolCallId, async () => {
      const result = await ctx.activity(name, async () => {
        beforeLiveTool();
        return capLong(await run(), toolCallId);
      });
      // Not past a limit or a Stop: what `run` did is written, whenever it ran.
      await ctx.activity(`${name}:write`, async (tx) => {
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
  const shell = shellDefinition.server(({ command, cwd, timeoutSeconds }, context) =>
    toolCall(context?.toolCallId, async () => {
      // The start marker: a resumed loop that replays it with no result never runs the command
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
        return onLiveComputer(async (computer, live) => {
          const result = await computer.run(command, {
            ...live,
            cwd: resolvePath(owner.botId, cwd),
            timeoutMs: (timeoutSeconds ?? defaultShellTimeoutSeconds) * 1000,
          });
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
  const computerCall: LoopKit["computerCall"] = (name, toolCallId, operate, cap = true) =>
    toolCall(toolCallId, async () =>
      recordTold(
        await ctx.activity(name, async () => {
          beforeLiveTool();
          const result = await onLiveComputer(operate);
          // Cut inside the activity, so the Checkpoint holds only the cut form. A rebuilt note
          // is the result's last field, so it stays in the cut text's end.
          return cap ? await capLong(result, toolCallId) : result;
        }),
      ),
    );
  /** A file tool: one activity, re-run after a crash, and a live call like `shell`'s. */
  const fileTool =
    <Input, Output extends object>(
      name: string,
      run: (
        computer: ComputerHandle,
        botId: string,
        input: Input,
        options: FileToolOptions,
      ) => Promise<Output>,
      cap = true,
    ) =>
    (input: Input, context?: { toolCallId?: string }) =>
      computerCall(
        name,
        context?.toolCallId,
        (computer, live) => run(computer, owner.botId, input, live),
        cap,
      );
  const computerTools = [
    shell,
    readDefinition.server(fileTool("read", readTool, false)),
    writeDefinition.server(fileTool("write", writeTool)),
    editDefinition.server(fileTool("edit", editTool)),
    listDefinition.server(fileTool("list", listTool)),
  ];

  /** What the loop's model calls and tool calls added to its input, in order. */
  const messages: ModelMessage[] = [];
  try {
    const {
      systemPrompts,
      tools,
      ended = () => false,
    } = await options.setup({ liveActivity, liveRequest, computerTools, computerCall });
    let reminded = false;
    for (;;) {
      let engine: ChatMiddlewareContext | undefined;
      const stream = chat({
        adapter: durableAdapter,
        messages: [...options.input, ...messages],
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
            // Before each model call: what the inbox holds joins the input, and stays in it.
            onConfig: async (middlewareCtx, config) => {
              const { inbox } = options;
              if (!inbox || middlewareCtx.phase !== "beforeModel") return;
              let arrived: string[];
              try {
                arrived = await ctx.activity("inbox", inbox);
              } catch (caught) {
                // It recorded nothing: the job retries it, as for a model call's Checkpoint.
                if (!abortController.signal.aborted) {
                  failure ??= caught;
                  abortController.abort();
                }
                throw caught;
              }
              if (arrived.length === 0) return;
              const turns = arrived.map((content) => ({ role: "user" as const, content }));
              return {
                messages: [...config.messages, ...turns],
                providerMessages: [...(config.providerMessages ?? config.messages), ...turns],
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
    failure,
  };
}

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
