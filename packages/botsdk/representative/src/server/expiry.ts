import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { representativeThread } from "./db/schema";

/*
 * A closed Customer thread's expiry (ticket #1285, spec #1170): 12 months after it closes, its row,
 * messages and summary are deleted; a Customer's profile lasts until the Customer is deleted. Recurring
 * jobs aren't supported, so each close queues one delayed job, like the idle check. A hand-off keeps
 * its Customer id, so the Customer's delete still finds what to redact.
 */

/** How long a closed thread is kept: 12 months, as 365 days. */
export const threadExpiryMs = 365 * 24 * 60 * 60_000;

export const threadExpiryJobName = "representative.thread-expiry";

const payload = z.object({ threadId: z.uuid() });

/** Deletes the thread if it is closed; nothing once it is gone, or open again. */
export const threadExpiryJob = defineJob<z.infer<typeof payload>>({
  name: threadExpiryJobName,
  payload,
  run: async ({ threadId }, job) => {
    await job.step("representative_thread_expiry", async (tx) => {
      // Messages, the summary and proofs go with the row; a hand-off only forgets the thread.
      await tx
        .delete(representativeThread)
        .where(
          and(eq(representativeThread.id, threadId), eq(representativeThread.state, "closed")),
        );
    });
  },
});

/**
 * Queues the expiry due `threadExpiryMs` after `closedAt`, in the transaction that closes the thread.
 * Keyed by when it is due, so a thread closed again after undoing a merge gets its own.
 */
export async function queueThreadExpiry(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  threadId: string,
  closedAt: Date,
) {
  const dueAt = new Date(closedAt.getTime() + threadExpiryMs);
  await jobs.enqueueIn(
    tx,
    threadExpiryJob,
    { threadId },
    { idempotencyKey: `${threadExpiryJobName}:${threadId}:${dueAt.getTime()}`, runAfter: dueAt },
  );
}
