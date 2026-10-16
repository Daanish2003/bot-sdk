import { type StoredParts, storedParts } from "../../shared/message-parts";
import { message } from "../db/schema";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { and, eq, isNull, lt, or } from "drizzle-orm";

import type { AppDeps } from "../deps";
import { cancelRunningCalls, searchTextOf } from "../../shared/chat/parts";
import { resolveModelCall } from "../credentials/resolve";
import type { RunEndEvent } from "./hooks";
import { enqueueMemories } from "../memory/make";
import { titleConversation } from "./title";
import type { ModelMeter } from "./meter";
import type { MessageUsage } from "../../shared/chat/message-record";
import type { Executor } from "./run";

type MessageErrorReason = NonNullable<(typeof message.$inferInsert)["errorReason"]>;

/**
 * How a Run ended, as its Message saves it: `complete`, `stopped`, waiting for an Approval
 * (ADR 0008), or `error`. An error is `timed_out`, `interrupted`, or a Provider's error message
 * with the reason it happened.
 */
export type Ending =
  | { status: "complete" | "stopped" }
  | { status: "awaiting_approval"; threadId: string; interruptedRunId: string }
  | { status: "error"; error: "timed_out" | "interrupted" }
  | { status: "error"; error: string; errorReason: MessageErrorReason };

/** The Run being ended: its Message, its log, whose it is, and the parts it ended with. */
export type EndingRun = {
  messageId: string;
  /** The Run's log id (`runLogId`), which `onRunEnd` reports as its `runId`. */
  runId: string;
  userId: string;
  conversationId: string;
  /** The `"provider:model"` id the Run used (`""` when the Message has none). */
  model: string;
  /**
   * The parts the Message ended with. They are saved with every running call `cancelled`. Unset
   * leaves the stored parts as they are: a row whose parts don't parse holds no running call.
   */
  parts?: StoredParts;
  /**
   * Set when the process that ran the Run ends it. Unset for a Run ended without its owner (stopped
   * from another process, or reaped), which saves no usage and starts no title or Memory job.
   */
  owner?: {
    /** The usage saved on the Message: the Provider's, or an estimate. */
    usage: MessageUsage;
    /** The compaction context start to save, when the Run compacted (`compactionFor`). */
    contextStartId?: string | null;
    /** The reply text this Run produced, for the output check (#268). */
    text: string;
    /** The Model call's meter: on Host credentials it records the Run in `chat.usage` (ADR 0007). */
    meter: ModelMeter;
    /** The Provider-reported cost in USD, when every iteration reported one. */
    reportedCost?: number;
    /** Whether the log already holds the Run's own RUN_FINISHED or RUN_ERROR. */
    logEnded: boolean;
    /** The thread and run ids the Run's chunks carried, so the ending chunk belongs to the same run. */
    ids?: { threadId: string; runId: string };
  };
};

/**
 * Ends a Run (ADR 0002, 0006, 0008), whichever path ends it: the owner once its stream is done,
 * a Stop of an orphaned Run, or the reaper. In order:
 *
 * 1. Saves the ending on the Message, only while it is still `streaming` (and, with `staleBefore`,
 *    still past its lease), with its running calls `cancelled`.
 * 2. The owner's output check (#268), which can hide the reply, and its Host usage row.
 * 3. Ends the Run's log, with the `moderated` chunk for a hidden reply (#269), and closes it.
 * 4. `onRunEnd`, last, and only when the ending was saved (#265).
 * 5. The owner's follow-on jobs: a title for a `complete` Run, Memories for a saved `complete` or
 *    `stopped` one that isn't hidden (ADR 0013).
 *
 * Answers the Run's `onRunEnd` event, or `undefined` when the Message had already ended. With
 * `fire: false` the event isn't fired: a caller inside a transaction fires it once it commits.
 */
export async function endRun(
  deps: AppDeps,
  run: EndingRun,
  ending: Ending,
  {
    db = deps.db,
    staleBefore,
    fire = true,
  }: { db?: Executor; staleBefore?: Date; fire?: boolean } = {},
): Promise<RunEndEvent | undefined> {
  const { messageId, owner } = run;
  const parts = run.parts && cancelRunningCalls(run.parts);
  const saved = await save(deps, db, messageId, {
    fields: {
      ...ending,
      ...(parts && { parts, searchText: searchTextOf(parts) }),
      ...(owner && { usage: owner.usage }),
      ...(owner?.contextStartId !== undefined && { contextStartId: owner.contextStartId }),
    },
    whileStreaming: true,
    staleBefore,
  });

  // The output check, after the ending is saved and before anything else is reported. A reply
  // that an earlier Run of its Message already hid stays hidden, so this Run's text is erased too.
  let hidden = false;
  if (saved && owner) {
    const verdict =
      owner.text === ""
        ? undefined
        : await deps.hooks.moderate({
            phase: "output",
            userId: run.userId,
            conversationId: run.conversationId,
            messageId,
            runId: run.runId,
            onHostCredentials: owner.meter.onHost,
            text: owner.text,
          });
    if (verdict?.allow === false || (await isHidden(deps, messageId))) {
      hidden = await save(deps, db, messageId, {
        fields: {
          parts: storedParts([]),
          searchText: "",
          ...(verdict?.allow === false && {
            hiddenAt: new Date(),
            hiddenReason: verdict.reason ?? null,
          }),
        },
      });
    }
  }
  // Recorded before the log closes, so a reader that has seen the end also sees the usage row.
  await owner?.meter.record({
    kind: "run",
    usage: owner.usage,
    reportedCost: owner.reportedCost,
  });

  if (saved || owner) {
    await endLog(deps, run, ending, hidden);
  }

  let event: RunEndEvent | undefined;
  if (saved) {
    // The owner knows whether it ran on Host credentials. Without it, that is read as the Model
    // resolves for its user now.
    const onHostCredentials = owner
      ? owner.meter.onHost
      : run.model !== "" &&
        (await resolveModelCall(deps, run.userId, run.model))?.meter.onHost === true;
    event = {
      userId: run.userId,
      conversationId: run.conversationId,
      messageId,
      runId: run.runId,
      ending: ending.status,
      ...(ending.status === "error" && {
        reason: "errorReason" in ending ? ending.errorReason : ending.error,
      }),
      model: run.model,
      onHostCredentials,
      hidden,
    };
    // Last: the ending, the usage row and the log's end are all written by now (#265).
    if (fire) deps.hooks.fire("onRunEnd", event);
  }

  if (owner) {
    // Title the Conversation, fire-and-forget. A reply waiting for Approval is titled once its
    // resumed Run completes.
    if (ending.status === "complete") void titleConversation(deps, messageId);
    // `error`, a hidden reply (owner decision on #286) and a Run waiting for Approval make no
    // Memories; the resumed Run does.
    if (saved && !hidden && (ending.status === "complete" || ending.status === "stopped")) {
      void enqueueMemories(deps, {
        userId: run.userId,
        conversationId: run.conversationId,
        replyId: messageId,
      }).catch((caught: unknown) =>
        deps.logger.error(`Queuing the Memories of ${messageId} failed`, caught),
      );
    }
  }
  return event;
}

/**
 * Saves `fields` on the Message. Resolves to whether a row was saved: false when the write failed
 * or the Message is gone (its Conversation was deleted). With `whileStreaming`, a Message that
 * already ended (stopped by another process) is left as it is, and so is false; with
 * `staleBefore`, so is one whose heartbeat is newer.
 */
async function save(
  deps: AppDeps,
  db: Executor,
  messageId: string,
  {
    fields,
    whileStreaming = false,
    staleBefore,
  }: {
    fields: Partial<typeof message.$inferInsert>;
    whileStreaming?: boolean;
    staleBefore?: Date;
  },
): Promise<boolean> {
  try {
    const rows = await db
      .update(message)
      .set(fields)
      .where(
        and(
          eq(message.id, messageId),
          whileStreaming ? eq(message.status, "streaming") : undefined,
          staleBefore
            ? or(isNull(message.heartbeatAt), lt(message.heartbeatAt, staleBefore))
            : undefined,
        ),
      )
      .returning({ id: message.id });
    return rows.length > 0;
  } catch (caught) {
    deps.logger.error(`Saving Message ${messageId} failed`, caught);
    return false;
  }
}

/**
 * Ends the Run's log and closes it. A Run that was stopped, timed out or threw has no terminal
 * chunk of its own; a reader that sees its log end without one takes the stream as cut off and
 * reconnects, which starts the Run again (the #71 lesson), so the log is ended explicitly. A
 * hidden reply's log ends with the `moderated` chunk, so every reader drops its text (#269).
 */
async function endLog(deps: AppDeps, run: EndingRun, ending: Ending, hidden: boolean) {
  const append = (chunk: StreamChunk) =>
    deps.runStreams
      .append(run.runId, chunk)
      .catch((caught: unknown) =>
        deps.logger.error(`Logging Message ${run.messageId} failed`, caught),
      );
  // A no-op for the owner's log, which is open already.
  await deps.runStreams.open(run.runId);
  if (!run.owner?.logEnded) {
    await append(
      endingChunk(
        run.owner?.ids ?? { threadId: run.messageId, runId: run.messageId },
        ending.status === "error" ? ending.error : undefined,
      ),
    );
  }
  if (hidden) await append(moderatedChunk());
  await deps.runStreams.close(run.runId);
}

/**
 * The custom chunk a hidden reply's Run log ends with (#269). The client drops the reply's text
 * when it reads it, so a reader that joins or reloads mid-Run hides it too.
 */
export function moderatedChunk(): StreamChunk {
  return { type: EventType.CUSTOM, name: "moderated", value: {}, timestamp: Date.now() };
}

/** Whether an earlier Run of the Message already hid its reply (#268). */
async function isHidden(deps: AppDeps, messageId: string): Promise<boolean> {
  try {
    const [row] = await deps.db
      .select({ hiddenAt: message.hiddenAt })
      .from(message)
      .where(eq(message.id, messageId));
    return row?.hiddenAt != null;
  } catch (caught) {
    // The Run's ending is saved by now, so a failed read must not stop the Run's other steps.
    deps.logger.error(`Reading whether Message ${messageId} is hidden failed`, caught);
    return false;
  }
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
