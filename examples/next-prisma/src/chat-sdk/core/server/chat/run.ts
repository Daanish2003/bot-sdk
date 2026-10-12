import { type StoredPart, storedPartsSchema } from "../../shared/message-parts";
import { conversation, message } from "../db/schema/chat";
import {
  type AnyTextAdapter,
  type ChatMiddleware,
  chat,
  EventType,
  fromSpecTokenUsage,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";

import type { AppDeps, Credentials } from "../deps";
import { cancelRunningCalls, createPartsBuilder, searchTextOf } from "../../shared/chat/parts";
import { titleConversation } from "./title";
import {
  createToolBudget,
  spentCalls,
  trackTools,
  type HostServerTool,
  type HostToolContext,
} from "./host-tools";
import type { McpTools } from "../mcp/tools";
import { createWebSearchTool } from "./web-search-tool";
import { createFetchUrlTool } from "./fetch-url-tool";
import { cancelChannel, heartbeatExpired, listenForStop, stopRequested } from "./stop";
import { addUsage, messageUsage, normalizeUsage, promptCharactersOf, type RunUsage } from "./usage";
import {
  recordHostUsage,
  recordSearchUsage,
  type SearchMeter,
  type UsageMeter,
} from "./host-usage";

type MessageUpdate = Partial<typeof message.$inferInsert>;
type MessageErrorReason = NonNullable<MessageUpdate["errorReason"]>;
type ProviderError = { message: string; code?: string };

/**
 * Runs one assistant Message (ADR 0002). The run drains `chat()` to the end on its own,
 * whether or not anyone reads the returned chunks: it snapshots the streaming Message's parts
 * every `deps.limits.snapshotIntervalMs`, and finishes the row in `finally`. A Stop aborts it, from
 * the pub/sub signal or from `cancel_requested_at` read back on a snapshot tick (ADR 0006).
 *
 * Every chunk goes to the Run's log before anyone reads it (ADR 0006). The POST response and any
 * joiner read that log, so a reader that goes away only stops reading.
 */
export async function startRun(
  deps: AppDeps,
  {
    messageId,
    runNumber = 1,
    initialParts = [],
    resume,
    provider,
    adapter,
    messages,
    webSearch,
    fetchUrl = false,
    hostTools = [],
    context,
    systemPrompts,
    modelOptions,
    compaction,
    meter,
    searchMeter,
    mcp,
  }: {
    messageId: string;
    /** The Run's number on its Message: a decision on a waiting call starts the next one (ADR 0008). */
    runNumber?: number;
    /** The parts the Message holds before this Run, which a resumed Run's reply continues. */
    initialParts?: StoredPart[];
    /**
     * Set on a Run that answers a call waiting for Approval: the thread and the Run that ended
     * waiting, and the user's decision (ADR 0008).
     */
    resume?: ResumeOf;
    /** The Provider of the Model, which decides how its usage is normalised. */
    provider: string;
    adapter: AnyTextAdapter;
    messages: ModelMessage[];
    /** The user's Tavily Tool credential, when this reply offers the `web_search` tool. */
    webSearch?: Credentials;
    /** Whether this reply offers the `fetch_url` tool, which needs no credential. */
    fetchUrl?: boolean;
    /** The Host tools this reply offers (none when its Model has no tools). */
    hostTools?: HostServerTool[];
    /** The user and Conversation the Host tools are called for, passed to them as their context. */
    context: HostToolContext;
    /** The reply's system prompts, from `systemPromptsFor` when the Run starts. */
    systemPrompts: string[];
    /** The Provider's options for the Run, from `generationOptionsFor` (max output, reasoning). */
    modelOptions?: Record<string, unknown>;
    /**
     * Drops the oldest Messages a model call would send past the window (`compactionFor`). Its
     * context start is saved on the Message when the Run ends.
     */
    compaction?: { middleware: ChatMiddleware; contextStartId: () => string | null };
    /** Set on a Run on Host credentials: the Run is recorded in `chat.usage` (ADR 0007). */
    meter?: UsageMeter;
    /** Set when the search runs on the Host's Tavily key: each search is recorded (ADR 0007). */
    searchMeter?: SearchMeter;
    /**
     * The MCP tools this Run offers, opened by the caller (spec #91). The Run closes them when it
     * ends, Stop included. `undefined` when no Connection is switched on.
     */
    mcp?: McpTools;
  },
): Promise<void> {
  const abortController = new AbortController();
  const logId = runLogId(messageId, runNumber);
  let unsubscribeStop: Awaited<ReturnType<typeof listenForStop>>;
  try {
    await deps.runStreams.open(logId);
    unsubscribeStop = await listenForStop(deps, messageId, () => abortController.abort());
  } catch (caught) {
    // The Run never started, so nothing else will close the clients it was given.
    await mcp?.close();
    throw caught;
  }
  // Registered once nothing before the Run's own `finally` can throw, so it always leaves again.
  deps.lifecycle.runs.set(messageId, abortController);
  const parts = createPartsBuilder(initialParts);
  // One budget for the reply's Host and MCP calls, across its Runs (spec #91).
  const budget = createToolBudget(spentCalls(initialParts));
  /** The call a reply stops on, waiting for Approval, and the Run that stopped (ADR 0008). */
  let awaiting: { toolCallId: string; threadId: string; runId: string } | undefined;
  // The Run's usage, summed over its model iterations as the stream is read (issue #117).
  let total: RunUsage | undefined;
  /** The Provider-reported cost in USD, summed over the Run's iterations, when it reports one. */
  let reportedCost: number | undefined;
  let costComplete = true;
  const promptCharacters = promptCharactersOf(messages);

  let writes = Promise.resolve();
  const write = (fields: MessageUpdate) => {
    writes = writes
      .then(async () => {
        await deps.db.update(message).set(fields).where(eq(message.id, messageId));
      })
      .catch((error: unknown) => console.error(`Saving Message ${messageId} failed`, error));
    return writes;
  };
  const withParts = (fields: MessageUpdate = {}): MessageUpdate => {
    const snapshot = parts.parts();
    return { parts: snapshot, searchText: searchTextOf(snapshot), ...fields };
  };

  let changed = false;
  const snapshotTimer = setInterval(() => {
    // Every tick writes the heartbeat, even when nothing changed: it is the Run's lease (ADR 0006).
    const heartbeat = { heartbeatAt: new Date() };
    void write(changed ? withParts(heartbeat) : heartbeat);
    changed = false;
    // The Stop signal is at most once, so a Stop it missed is found in the column.
    void stopRequested(deps, messageId)
      .then((requested) => {
        if (requested) abortController.abort();
      })
      .catch((error: unknown) => console.error(`Reading Stop of ${messageId} failed`, error));
  }, deps.limits.snapshotIntervalMs);

  /** Whether the log already holds its own RUN_FINISHED or RUN_ERROR. */
  let logEnded = false;
  let ids: { threadId: string; runId: string } | undefined;
  let timedOut = false;
  const capTimer = setTimeout(() => {
    // A run that was stopped but hasn't ended yet stays stopped.
    if (abortController.signal.aborted) return;
    timedOut = true;
    abortController.abort();
  }, deps.limits.runCapMs);

  void (async () => {
    let error: ProviderError | undefined;
    try {
      const mcpNames = new Set((mcp?.tools ?? []).map((tool) => tool.name));
      const tools = [
        ...(webSearch
          ? [
              createWebSearchTool({
                searchClient: deps.searchClient,
                credentials: webSearch,
                parts,
                onChange: () => (changed = true),
                recordSearch: searchMeter
                  ? () =>
                      recordSearchUsage(deps, searchMeter).catch((caught: unknown) =>
                        console.error(`Recording a search of ${messageId} failed`, caught),
                      )
                  : undefined,
              }),
            ]
          : []),
        ...(fetchUrl
          ? [
              createFetchUrlTool({
                fetch: deps.fetch,
                timeoutMs: deps.limits.fetchTimeoutMs,
                parts,
                onChange: () => (changed = true),
              }),
            ]
          : []),
        ...trackTools(hostTools, {
          source: "host",
          parts,
          onChange: () => (changed = true),
          budget,
        }),
        ...trackTools(mcp?.tools ?? [], {
          source: "mcp",
          parts,
          onChange: () => (changed = true),
          budget,
        }),
      ];
      const stream = chat({
        adapter,
        messages,
        abortController,
        context,
        ...(tools.length > 0 && { tools }),
        ...(systemPrompts.length > 0 && { systemPrompts }),
        modelOptions,
        ...(compaction && { middleware: [compaction.middleware] }),
        // A resumed Run continues the thread and the Run that ended waiting (ADR 0008, spike #154).
        ...(resume && {
          threadId: resume.threadId,
          parentRunId: resume.parentRunId,
          resume: [
            {
              interruptId: resume.interruptId,
              status: "resolved",
              payload: { approved: resume.approved },
            },
          ],
        }),
      });
      for await (const chunk of untilAborted(stream, abortController.signal)) {
        parts.add(chunk);
        changed = true;
        const approval = approvalOf(chunk);
        const chunkIds = runIdsOf(chunk);
        if (approval && chunkIds) {
          // The Run ends here, with the call stored as waiting (ADR 0008): nothing waits in a process.
          awaiting = { toolCallId: approval, ...chunkIds };
          parts.awaitApproval(approval, mcpNames);
        }
        if (chunk.type === EventType.RUN_FINISHED && chunk.usage) {
          // The AG-UI array form is converted back to TanStack's shape first.
          const tokens = Array.isArray(chunk.usage) ? fromSpecTokenUsage(chunk.usage) : chunk.usage;
          if (tokens) total = addUsage(total, normalizeUsage(provider, tokens));
          // A Provider that reports a cost (OpenRouter) prices a Host Run exactly (ADR 0007). A cost
          // reported for only some iterations would undercount, so it is used only when all report one.
          if (tokens?.cost === undefined) costComplete = false;
          else reportedCost = (reportedCost ?? 0) + tokens.cost;
        }
        if (chunk.type === EventType.RUN_ERROR) {
          error = { message: chunk.message, code: chunk.code ?? chunk.error?.code };
        }
        if (chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR) {
          logEnded = true;
        }
        ids ??= runIdsOf(chunk);
        void deps.runStreams
          .append(logId, chunk)
          .catch((error: unknown) => console.error(`Logging Message ${messageId} failed`, error));
      }
    } catch (caught) {
      error = thrownError(caught);
    } finally {
      clearInterval(snapshotTimer);
      clearTimeout(capTimer);
      parts.cancelRunningCalls();
      // The MCP clients close with the Run, Stop included (spec #91).
      await mcp?.close();
      const interrupted = abortController.signal.reason === shutdownAbort;
      const ending: MessageUpdate = timedOut
        ? { status: "error", error: "timed out" }
        : interrupted
          ? { status: "error", error: "interrupted" }
          : abortController.signal.aborted
            ? { status: "stopped" }
            : error !== undefined
              ? {
                  status: "error",
                  error: error.message,
                  errorReason: errorReasonOf(error.code),
                }
              : awaiting
                ? {
                    status: "awaiting_approval",
                    threadId: awaiting.threadId,
                    interruptedRunId: awaiting.runId,
                  }
                : { status: "complete" };
      // Stored whatever the ending: the Provider's usage for a finished model call, else an estimate.
      const usage = messageUsage(
        ending.status === "complete" || ending.status === "awaiting_approval" ? total : undefined,
        {
          promptCharacters,
          parts: parts.parts().parts,
        },
      );
      await write(
        withParts({
          ...ending,
          usage,
          ...(compaction && { contextStartId: compaction.contextStartId() }),
        }),
      );
      // Recorded before the log closes, so a reader that has seen the end also sees the usage row.
      if (meter) {
        await recordHostUsage(
          deps,
          "run",
          meter,
          usage,
          costComplete ? reportedCost : undefined,
        ).catch((caught: unknown) =>
          console.error(`Recording usage of ${messageId} failed`, caught),
        );
      }
      void unsubscribeStop().catch((error: unknown) =>
        console.error(`Unsubscribing Stop of ${messageId} failed`, error),
      );
      // A Run that was stopped, timed out or threw has no terminal chunk of its own. A reader that
      // sees its log end without one takes the stream as cut off and reconnects, which starts the
      // Run again, so the log is ended explicitly.
      if (!logEnded) {
        void deps.runStreams
          .append(
            logId,
            endingChunk(
              ids ?? { threadId: messageId, runId: messageId },
              timedOut ? "timed out" : interrupted ? "interrupted" : error?.message,
            ),
          )
          .catch((caught: unknown) => console.error(`Logging Message ${messageId} failed`, caught));
      }
      await deps.runStreams.close(logId);
      deps.lifecycle.runs.delete(messageId);
      // The run ended `complete`: title its Conversation, fire-and-forget. A reply waiting for
      // Approval is titled once its resumed Run completes.
      if (
        !timedOut &&
        !abortController.signal.aborted &&
        error === undefined &&
        awaiting === undefined
      ) {
        void titleConversation(deps, messageId);
      }
    }
  })();
}

/**
 * The id a Message's Run log is keyed by: the Message's id for its first Run (ADR 0006), and
 * `<messageId>:<n>` for the Run that answers a decision on a waiting call (ADR 0008).
 */
export function runLogId(messageId: string, runNumber: number) {
  return runNumber <= 1 ? messageId : `${messageId}:${runNumber}`;
}

/** What a decision on a waiting call resumes: the thread, the Run that ended waiting, and the answer. */
export type ResumeOf = {
  threadId: string;
  parentRunId: string;
  interruptId: string;
  approved: boolean;
};

/**
 * The tool call id of a RUN_FINISHED that ends waiting for Approval (the interrupt's id is
 * `approval_<toolCallId>`), or `undefined` for any other chunk.
 */
function approvalOf(chunk: StreamChunk): string | undefined {
  if (chunk.type !== EventType.RUN_FINISHED) return undefined;
  const outcome = (chunk as { outcome?: { type?: unknown; interrupts?: Array<{ id?: unknown }> } })
    .outcome;
  if (outcome?.type !== "interrupt") return undefined;
  const id = outcome.interrupts?.[0]?.id;
  return typeof id === "string" && id.startsWith(approvalPrefix)
    ? id.slice(approvalPrefix.length)
    : undefined;
}

/** The interrupt id prefix TanStack AI gives a tool call that needs Approval. */
export const approvalPrefix = "approval_";

/** The thread and run ids a chat() chunk carries, so the ending chunk belongs to the same run. */
function runIdsOf(chunk: StreamChunk) {
  const { threadId, runId } = chunk as { threadId?: unknown; runId?: unknown };
  return typeof threadId === "string" && typeof runId === "string"
    ? { threadId, runId }
    : undefined;
}

/** The chunk that ends a Run's log: a `RUN_ERROR` when it failed or timed out, else a `RUN_FINISHED`. */
function endingChunk(
  ids: { threadId: string; runId: string },
  errorMessage: string | undefined,
): StreamChunk {
  const timestamp = Date.now();
  return errorMessage === undefined
    ? { type: EventType.RUN_FINISHED, ...ids, finishReason: "stop", timestamp }
    : { type: EventType.RUN_ERROR, ...ids, message: errorMessage, timestamp };
}

/**
 * The stream's chunks until the signal aborts. An adapter that ignored the signal would keep the
 * run waiting, so the run stops reading instead, and leaves the stream behind. The adapters that
 * ignored it (Bedrock, Mistral, Ollama) are made to cancel the request: see `adapters.ts` and
 * `patches/` (issue #54).
 */
async function* untilAborted<T>(stream: AsyncIterable<T>, signal: AbortSignal) {
  const iterator = stream[Symbol.asyncIterator]();
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted");
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  while (true) {
    const next = await Promise.race([iterator.next(), aborted]);
    if (next === "aborted") {
      void iterator.return?.()?.catch(() => {});
      return;
    }
    if (next.done) return;
    yield next.value;
  }
}

/** A thrown Provider error as a `RUN_ERROR` would report it: its message, and its code or status. */
function thrownError(caught: unknown): ProviderError {
  const { code, status } = (typeof caught === "object" && caught !== null ? caught : {}) as {
    code?: unknown;
    status?: unknown;
  };
  return {
    message: caught instanceof Error ? caught.message : String(caught),
    code: typeof code === "string" ? code : typeof status === "number" ? String(status) : undefined,
  };
}

/**
 * Why a Provider error happened, from the code the adapter reports: the Provider's error code
 * (OpenAI) or the HTTP status (Anthropic, whose SDK errors carry no code).
 */
function errorReasonOf(code: string | undefined): MessageErrorReason {
  switch (code) {
    case "401":
    case "403":
    case "invalid_api_key":
      return "invalid_key";
    case "429":
    case "rate_limit_exceeded":
    case "insufficient_quota":
      return "rate_limited";
    default:
      return "provider_error";
  }
}

/**
 * Stops the Run of a Message from any process (ADR 0006). It sets `cancel_requested_at` and
 * publishes the Stop; the owning process aborts and saves the Message `stopped`. It never writes
 * `status`, unless the Run's heartbeat has expired: then no owner is left, so the Message is
 * marked `stopped` here and its log is ended. Ended Messages stay as they are.
 */
export async function stopRun(deps: AppDeps, messageId: string, db: Executor = deps.db) {
  const [requested] = await db
    .update(message)
    .set({ cancelRequestedAt: new Date() })
    .where(and(eq(message.id, messageId), eq(message.status, "streaming")))
    .returning({ createdAt: message.createdAt, heartbeatAt: message.heartbeatAt });
  if (!requested) return;
  await deps.pubsub.publish(cancelChannel(messageId), "stop");
  if (!heartbeatExpired(requested)) return;
  await endOrphanedRun(deps, messageId, db);
}

/** The database, or the transaction a caller is in (`deleteUser` stops Runs inside its own). */
export type Executor = AppDeps["db"] | Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];

/**
 * Stops every live Run in the user's Conversations through the Stop path, inside the caller's
 * transaction. Their owners write nothing more once the rows the caller deletes are gone.
 */
export async function stopUserRuns(deps: AppDeps, userId: string, db: Executor = deps.db) {
  await stopLiveRuns(deps, eq(conversation.userId, userId), db);
}

/**
 * Stops every live Run in one Project's Conversations, inside the caller's transaction. As
 * `stopUserRuns`, for `project.delete`.
 */
export async function stopProjectRuns(deps: AppDeps, projectId: string, db: Executor = deps.db) {
  await stopLiveRuns(deps, eq(conversation.projectId, projectId), db);
}

/** Stops the live Runs whose Conversation matches `where`. */
async function stopLiveRuns(deps: AppDeps, where: SQL, db: Executor) {
  const live = await db
    .select({ id: message.id })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(where, eq(message.status, "streaming")));
  for (const { id } of live) await stopRun(deps, id, db);
}

/**
 * Saves a streaming Message whose owner is gone as `stopped`, cancels its running searches and
 * ends its log, so a reader does not reconnect and start it again (the #71 lesson).
 */
async function endOrphanedRun(deps: AppDeps, messageId: string, db: Executor) {
  const [row] = await db
    .select({ parts: message.parts, runNumber: message.runNumber })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.status, "streaming")));
  if (!row) return;
  const parsed = storedPartsSchema.safeParse(row.parts);
  const ended = await db
    .update(message)
    .set({
      status: "stopped",
      ...(parsed.success && { parts: cancelRunningCalls(parsed.data) }),
    })
    .where(and(eq(message.id, messageId), eq(message.status, "streaming")))
    .returning({ id: message.id });
  if (ended.length === 0) return;
  const logId = runLogId(messageId, row.runNumber);
  await deps.runStreams.open(logId);
  await deps.runStreams.append(
    logId,
    endingChunk({ threadId: messageId, runId: messageId }, undefined),
  );
  await deps.runStreams.close(logId);
}

/**
 * The reason a Run is aborted with when `stop()` ends it after the drain, so the Run saves itself
 * `error` "interrupted" rather than `stopped`.
 */
export const shutdownAbort = new Error("The chat SDK is stopping");

/**
 * Reaps the Runs whose owner has stopped heartbeating (ADR 0006), from any process: every
 * `streaming` Message whose heartbeat is older than the lease, or was never written, ends as
 * `error` "interrupted". A search it left running is `cancelled`, and its log ends with a
 * `RUN_ERROR` and closes, so a reader doesn't reconnect into a Run that is gone.
 */
export async function reapStaleRuns(deps: AppDeps, now = new Date()) {
  const cutoff = new Date(now.getTime() - deps.limits.leaseMs);
  const reaped = await deps.db
    .update(message)
    .set({ status: "error", error: "interrupted" })
    .where(
      and(
        eq(message.status, "streaming"),
        or(isNull(message.heartbeatAt), lt(message.heartbeatAt, cutoff)),
      ),
    )
    .returning({ id: message.id, parts: message.parts, runNumber: message.runNumber });
  for (const row of reaped) {
    // A row that doesn't parse holds no running call, and mustn't stop the reaper.
    const parsed = storedPartsSchema.safeParse(row.parts);
    if (
      parsed.success &&
      parsed.data.parts.some(
        (part) =>
          (part.type === "web_search" || part.type === "tool_call") && part.state === "running",
      )
    ) {
      await deps.db
        .update(message)
        .set({ parts: cancelRunningCalls(parsed.data) })
        .where(eq(message.id, row.id));
    }
    const ids = { threadId: row.id, runId: row.id };
    const logId = runLogId(row.id, row.runNumber);
    await deps.runStreams.open(logId);
    await deps.runStreams.append(logId, endingChunk(ids, "interrupted"));
    await deps.runStreams.close(logId);
  }
}
