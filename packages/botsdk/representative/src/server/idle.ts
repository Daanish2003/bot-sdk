import { and, eq, lte, ne } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { pruneProofs } from "./customer-proof";
import { representativeThread } from "./db/schema";

/*
 * A Customer thread closes after 7 idle days (ticket #1252). Recurring jobs aren't supported and a
 * feature has no boot hook, so each thread keeps one delayed job: it re-checks the thread's last
 * activity, closes it if it has been idle long enough, and otherwise queues the next check for the
 * day the idle time would be up.
 */

/** How long a thread may sit with no activity before it closes. */
export const threadIdleMs = 7 * 24 * 60 * 60_000;

export const threadIdleJobName = "representative.thread-idle";

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
            ne(representativeThread.state, "closed"),
            lte(representativeThread.updatedAt, new Date(now.getTime() - threadIdleMs)),
          ),
        )
        .returning({ id: representativeThread.id });
      if (closing.length > 0) return true;
      const [thread] = await tx
        .select({ updatedAt: representativeThread.updatedAt })
        .from(representativeThread)
        .where(
          and(eq(representativeThread.id, threadId), ne(representativeThread.state, "closed")),
        );
      if (thread) await queueIdleCheck(job, tx, threadId, thread.updatedAt);
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
