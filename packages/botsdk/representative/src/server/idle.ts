import { and, eq, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { codeHandOffKind, type StoredReplyKind } from "../shared/replies";
import { pruneProofs } from "./customer-proof";
import { lastMessageQuery } from "./last-message";
import { representativeThread, representativeThreadMessage } from "./db/schema";
import { afterThreadClose } from "./customer-summary";
import { draftWaitingQuery } from "./reply-drafts";
import { queueThreadExpiry } from "./expiry";

/*
 * A thread its Representative holds closes after 7 idle days (ticket #1252); one the owner holds
 * never does (#1253), and nor does one whose last word is code's fixed message, which promises the
 * Customer someone will follow up (#1261): it waits on whoever that is. A Reply draft waiting (#1306)
 * holds a thread open the same way, as the holding note made that promise too. Recurring jobs aren't supported and a feature has no boot hook, so each thread
 * keeps one delayed job: it re-checks the thread's last activity, closes it if it has been idle long
 * enough, and otherwise queues the next check for the day the idle time would be up. A held thread's
 * check looks again later, so the chain is still there after Hand back, which counts as activity.
 */

/** How long a thread its Representative holds may sit with no activity before it closes. */
export const threadIdleMs = 7 * 24 * 60 * 60_000;

export const threadIdleJobName = "representative.thread-idle";

const lastReplyKind = lastMessageQuery(representativeThreadMessage.replyKind);

const threadIdlePayload = z.object({ threadId: z.uuid() });
type ThreadIdlePayload = z.infer<typeof threadIdlePayload>;

/**
 * Keyed by when it is due, not by the thread alone: a check that re-queues itself runs while its
 * own key is still active, and an enqueue under an active key is a no-op.
 */
const idleCheckKey = (threadId: string, dueAt: Date) =>
  `${threadIdleJobName}:${threadId}:${dueAt.getTime()}`;

/** Closes the thread, or queues the next check; nothing once it is closed or gone. */
export const threadIdleJob = defineJob<ThreadIdlePayload>({
  name: threadIdleJobName,
  payload: threadIdlePayload,
  run: async ({ threadId }, job) => {
    const now = await job.now();
    const closed = await job.step("representative_thread_idle", async (tx) => {
      // One statement, so a message arriving as it runs either lands first (and the thread isn't
      // idle) or finds the thread closed and opens a new one.
      const closing = await tx
        .update(representativeThread)
        .set({ state: "closed" })
        .where(
          and(
            eq(representativeThread.id, threadId),
            eq(representativeThread.state, "representative"),
            lte(representativeThread.updatedAt, new Date(now.getTime() - threadIdleMs)),
            sql`(${lastReplyKind}) is distinct from ${codeHandOffKind}`,
            sql`not ${draftWaitingQuery}`,
          ),
        )
        .returning({ id: representativeThread.id });
      if (closing.length > 0) {
        await afterThreadClose(job, tx, threadId);
        await queueThreadExpiry(job, tx, threadId, now);
        return true;
      }
      const [thread] = await tx
        .select({
          state: representativeThread.state,
          updatedAt: representativeThread.updatedAt,
          lastReplyKind: sql<StoredReplyKind | null>`(${lastReplyKind})`,
          draftWaiting: sql<boolean>`${draftWaitingQuery}`,
        })
        .from(representativeThread)
        .where(
          and(eq(representativeThread.id, threadId), ne(representativeThread.state, "closed")),
        );
      if (thread) {
        // A held thread's last activity may be long past, which would queue this same check again.
        const held =
          thread.state === "owner" ||
          thread.lastReplyKind === codeHandOffKind ||
          thread.draftWaiting;
        const from = held ? now : thread.updatedAt;
        await queueIdleCheck(job, tx, threadId, from);
      }
      return false;
    });
    // After the thread's lock is let go: a message takes its proof's lock and then the thread's.
    if (closed) {
      await job.step("representative_thread_prune", (tx) => pruneProofs(tx, threadId, now));
    }
  },
});

/** Queues the check due `threadIdleMs` after `from`, in `tx`. A repeat of the same one is a no-op. */
export async function queueIdleCheck(
  context: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  threadId: string,
  from: Date,
) {
  const dueAt = new Date(from.getTime() + threadIdleMs);
  await context.jobs.enqueueIn(
    tx,
    threadIdleJob,
    { threadId },
    { idempotencyKey: idleCheckKey(threadId, dueAt), runAfter: dueAt },
  );
}
