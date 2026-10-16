import { type StoredPart, storedPartsSchema } from "../../shared/message-parts";
import { conversation, message } from "../db/schema";
import {
  type ChatMiddleware,
  chat,
  EventType,
  fromSpecTokenUsage,
  type StreamChunk,
} from "@tanstack/ai";
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";

import type { AppDeps } from "../deps";
import { createPartsBuilder, searchTextOf } from "../../shared/chat/parts";
import type { RunEndEvent } from "./hooks";
import { endRun, type Ending, type EndingRun } from "./end-run";
import { createToolBudget, spentCalls } from "./tracked-tool";
import { artifactCutOff } from "./artifact-tool";
import type { RunPlan } from "./run-plan";
import { cancelChannel, heartbeatExpired, listenForStop, stopRequested } from "./stop";
import { addUsage, messageUsage, normalizeUsage, promptCharactersOf, type RunUsage } from "./usage";

type MessageUpdate = Partial<typeof message.$inferInsert>;
type MessageErrorReason = NonNullable<MessageUpdate["errorReason"]>;
type ProviderError = { message: string; code?: string };

/** Which Run of its Message this is, beyond what the plan says. A send's first Run needs none. */
export type RunOf = {
  /** The Run's number on its Message: a decision on a waiting call starts the next one (ADR 0008). */
  runNumber?: number;
  /** The parts the Message holds before this Run, which a resumed Run's reply continues. */
  initialParts?: StoredPart[];
  /**
   * Set on a Run that answers a call waiting for Approval: the thread and the Run that ended
   * waiting, and the user's decision (ADR 0008).
   */
  resume?: ResumeOf;
};

/**
 * Runs one assistant Message (ADR 0002) from its plan (`planRun`, the only caller). The run drains
 * `chat()` to the end on its own, whether or not anyone reads the returned chunks: it snapshots the
 * streaming Message's parts every `deps.limits.snapshotIntervalMs`, and finishes the row in
 * `finally`. A Stop aborts it, from the pub/sub signal or from `cancel_requested_at` read back on a
 * snapshot tick (ADR 0006). The Run closes the plan's MCP clients when it ends, Stop included.
 *
 * Every chunk goes to the Run's log before anyone reads it (ADR 0006). The POST response and any
 * joiner read that log, so a reader that goes away only stops reading.
 */
export async function startRun(
  deps: AppDeps,
  plan: RunPlan,
  { runNumber = 1, initialParts = [], resume }: RunOf,
): Promise<void> {
  const { replyId: messageId, context, messages, compaction, meter } = plan;
  const { id: model, provider } = plan.model;
  const { mcp } = plan.offered;
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
  /** The reply text this Run produced, for the output check (#268): no reasoning, no tool arguments. */
  let runText = "";
  /** The Provider-reported cost in USD, summed over the Run's iterations, when it reports one. */
  let reportedCost: number | undefined;
  let costComplete = true;
  const promptCharacters = promptCharactersOf(messages);

  let writes = Promise.resolve();
  /** Saves a snapshot's `fields` on the Message, after the snapshots already queued. */
  const write = (fields: MessageUpdate) => {
    writes = writes
      .then(async () => {
        await deps.db.update(message).set(fields).where(eq(message.id, messageId));
      })
      .catch((error: unknown) => deps.logger.error(`Saving Message ${messageId} failed`, error));
  };
  const withParts = (fields: MessageUpdate = {}): MessageUpdate => {
    const snapshot = parts.parts();
    return { parts: snapshot, searchText: searchTextOf(snapshot), ...fields };
  };

  let changed = false;
  const snapshotTimer = setInterval(() => {
    // Every tick writes the heartbeat, even when nothing changed: it is the Run's lease (ADR 0006).
    const heartbeat = { heartbeatAt: new Date() };
    write(changed ? withParts(heartbeat) : heartbeat);
    changed = false;
    // The Stop signal is at most once, so a Stop it missed is found in the column.
    void stopRequested(deps, messageId)
      .then((requested) => {
        if (requested) abortController.abort();
      })
      .catch((error: unknown) => deps.logger.error(`Reading Stop of ${messageId} failed`, error));
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
      const tools = plan.tools({ parts, onChange: () => (changed = true), budget });
      const middleware: ChatMiddleware[] = [
        ...(plan.offered.artifacts ? [artifactCutOff] : []),
        ...(compaction ? [compaction.middleware] : []),
      ];
      const stream = chat({
        adapter: plan.adapter,
        messages,
        abortController,
        context,
        ...(tools.length > 0 && { tools }),
        ...(plan.systemPrompts.length > 0 && { systemPrompts: plan.systemPrompts }),
        modelOptions: plan.modelOptions,
        // The Artifact cut-off override runs first, so compaction sees the rewritten messages.
        ...(middleware.length > 0 && { middleware }),
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
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) runText += chunk.delta;
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
          .catch((error: unknown) =>
            deps.logger.error(`Logging Message ${messageId} failed`, error),
          );
      }
    } catch (caught) {
      error = thrownError(caught);
    } finally {
      clearInterval(snapshotTimer);
      clearTimeout(capTimer);
      // The parts as the stream ended: a call that finishes after this stays cancelled.
      const ended = parts.parts();
      // The MCP clients close with the Run, Stop included (spec #91).
      await mcp?.close();
      void unsubscribeStop().catch((error: unknown) =>
        deps.logger.error(`Unsubscribing Stop of ${messageId} failed`, error),
      );
      const ending = endingOf({
        timedOut,
        interrupted: abortController.signal.reason === shutdownAbort,
        stopped: abortController.signal.aborted,
        error,
        awaiting,
      });
      // Stored whatever the ending: the Provider's usage for a finished model call, else an estimate.
      const usage = messageUsage(
        ending.status === "complete" || ending.status === "awaiting_approval" ? total : undefined,
        { promptCharacters, parts: ended.parts },
      );
      // The ending is saved after every snapshot write already queued.
      await writes;
      try {
        await endRun(
          deps,
          {
            messageId,
            runId: logId,
            userId: context.userId,
            conversationId: context.conversationId,
            model,
            parts: ended,
            owner: {
              usage,
              ...(compaction && { contextStartId: compaction.contextStartId() }),
              text: runText,
              meter,
              reportedCost: costComplete ? reportedCost : undefined,
              logEnded,
              ids,
            },
          },
          ending,
        );
      } finally {
        deps.lifecycle.runs.delete(messageId);
      }
    }
  })();
}

/** How the owner's Run ended, from what stopped its stream. A cap or a shutdown wins over a Stop. */
function endingOf({
  timedOut,
  interrupted,
  stopped,
  error,
  awaiting,
}: {
  timedOut: boolean;
  interrupted: boolean;
  stopped: boolean;
  error: ProviderError | undefined;
  awaiting: { threadId: string; runId: string } | undefined;
}): Ending {
  if (timedOut) return { status: "error", error: "timed_out" };
  if (interrupted) return { status: "error", error: "interrupted" };
  if (stopped) return { status: "stopped" };
  if (error !== undefined) {
    return { status: "error", error: error.message, errorReason: errorReasonOf(error.code) };
  }
  if (awaiting) {
    return {
      status: "awaiting_approval",
      threadId: awaiting.threadId,
      interruptedRunId: awaiting.runId,
    };
  }
  return { status: "complete" };
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
export async function stopRun(
  deps: AppDeps,
  messageId: string,
  db: Executor = deps.db,
): Promise<RunEndEvent[]> {
  const [requested] = await db
    .update(message)
    .set({ cancelRequestedAt: new Date() })
    .where(and(eq(message.id, messageId), eq(message.status, "streaming")))
    .returning({ createdAt: message.createdAt, heartbeatAt: message.heartbeatAt });
  if (!requested) return [];
  await deps.pubsub.publish(cancelChannel(messageId), "stop");
  if (!heartbeatExpired(requested)) return [];
  return endOrphanedRun(deps, messageId, db);
}

/** The database, or the transaction a caller is in (`deleteUser` stops Runs inside its own). */
export type Executor = AppDeps["db"] | Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];

/**
 * Stops every live Run in the user's Conversations through the Stop path, inside the caller's
 * transaction. Their owners write nothing more once the rows the caller deletes are gone. Answers
 * the `onRunEnd` events of the Runs that ended without their owner: the caller fires them once its
 * transaction commits (#265).
 */
export async function stopUserRuns(
  deps: AppDeps,
  userId: string,
  db: Executor = deps.db,
): Promise<RunEndEvent[]> {
  return stopLiveRuns(deps, eq(conversation.userId, userId), db);
}

/**
 * Stops every live Run in one Project's Conversations, inside the caller's transaction. As
 * `stopUserRuns`, for `project.delete`.
 */
export async function stopProjectRuns(
  deps: AppDeps,
  projectId: string,
  db: Executor = deps.db,
): Promise<RunEndEvent[]> {
  return stopLiveRuns(deps, eq(conversation.projectId, projectId), db);
}

/** Stops the live Runs whose Conversation matches `where`. */
async function stopLiveRuns(deps: AppDeps, where: SQL, db: Executor): Promise<RunEndEvent[]> {
  const live = await db
    .select({ id: message.id })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(where, eq(message.status, "streaming")));
  const ended: RunEndEvent[] = [];
  for (const { id } of live) ended.push(...(await stopRun(deps, id, db)));
  return ended;
}

/**
 * Saves a streaming Message whose owner is gone as `stopped`, cancels its running calls and ends
 * its log, so a reader does not reconnect and start it again (the #71 lesson). Answers the Run's
 * `onRunEnd` event for the caller to fire, or none when the Message had already ended.
 */
async function endOrphanedRun(
  deps: AppDeps,
  messageId: string,
  db: Executor,
): Promise<RunEndEvent[]> {
  const [row] = await db
    .select(ownerlessRunColumns)
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(eq(message.id, messageId), eq(message.status, "streaming")));
  if (!row) return [];
  const event = await endRun(deps, ownerlessRun(row), { status: "stopped" }, { db, fire: false });
  return event ? [event] : [];
}

/** The columns a Run ended without its owner (stopped from another process, or reaped) is read from. */
const ownerlessRunColumns = {
  id: message.id,
  parts: message.parts,
  runNumber: message.runNumber,
  model: message.model,
  conversationId: message.conversationId,
  userId: conversation.userId,
};

function ownerlessRun(row: {
  id: string;
  parts: unknown;
  runNumber: number;
  model: string | null;
  conversationId: string;
  userId: string;
}): EndingRun {
  // A row that doesn't parse holds no running call, and mustn't stop its Run from ending.
  const parsed = storedPartsSchema.safeParse(row.parts);
  return {
    messageId: row.id,
    runId: runLogId(row.id, row.runNumber),
    userId: row.userId,
    conversationId: row.conversationId,
    model: row.model ?? "",
    ...(parsed.success && { parts: parsed.data }),
  };
}

/**
 * The reason a Run is aborted with when `stop()` ends it after the drain, so the Run saves itself
 * `error` "interrupted" rather than `stopped`.
 */
export const shutdownAbort = new Error("The chat SDK is stopping");

/**
 * Reaps the Runs whose owner has stopped heartbeating (ADR 0006), from any process: every
 * `streaming` Message whose heartbeat is older than the lease, or was never written, ends as
 * `error` "interrupted". A call it left running is `cancelled`, and its log ends with a
 * `RUN_ERROR` and closes, so a reader doesn't reconnect into a Run that is gone.
 */
export async function reapStaleRuns(deps: AppDeps, now = new Date()) {
  const cutoff = new Date(now.getTime() - deps.limits.leaseMs);
  const stale = await deps.db
    .select(ownerlessRunColumns)
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(message.status, "streaming"),
        or(isNull(message.heartbeatAt), lt(message.heartbeatAt, cutoff)),
      ),
    );
  for (const row of stale) {
    // Still past the lease when it is saved, so an owner that has just heartbeated keeps its Run.
    await endRun(
      deps,
      ownerlessRun(row),
      { status: "error", error: "interrupted" },
      { staleBefore: cutoff },
    );
  }
}
