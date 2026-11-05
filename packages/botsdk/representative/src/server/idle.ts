import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { codeHandOffKind, type StoredReplyKind } from "../shared/replies";
import { pruneProofs } from "./customer-proof";
import { lastMessageQuery } from "./last-message";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { afterThreadClose } from "./customer-summary";
import { heldWaitingQuery } from "./reply-drafts";
import { queueThreadExpiry } from "./expiry";

/*
 * A thread its Representative holds closes after 7 idle days (ticket #1252); one the owner holds
 * never does (#1253), and nor does one whose last word is code's fixed message, which promises the
 * Customer someone will follow up (#1261), and nor does one at a limit or with what waited through
 * one left for the owner (#1309): it waits on whoever that is. A message the gate held
 * holds a thread open the same way: the owner was told to answer it, and a thread that closed couldn't. Recurring jobs aren't supported and a feature has no boot hook, so each thread
 * keeps one delayed job: it re-checks the thread's last activity, closes it if it has been idle long
 * enough, and otherwise queues the next check for the day the idle time would be up. A held thread's
 * check looks again later, so the chain is still there after Hand back, which counts as activity.
 */

/** How long a thread its Representative holds may sit with no activity before it closes. */
export const threadIdleMs = 7 * 24 * 60 * 60_000;

export const threadIdleJobName = "representative.thread-idle";

const lastReplyKind = lastMessageQuery(representativeThreadMessage.replyKind);

/**
 * Whether what a limit left holds the thread open: not when no answer could reach its Customer, who is
 * blocked or opted out at the thread's address, as the owner's send is refused then and it would never close.
 */
const leftAnswerable = sql`(${representativeThread.leftForOwnerAt} is not null
  and not exists (select 1 from ${representativeCustomer}
    where ${representativeCustomer.id} = ${representativeThread.customerId}
      and ${representativeCustomer.blockedAt} is not null)
  and not exists (select 1 from ${representativeCustomerIdentity}
    where ${representativeCustomerIdentity.customerId} = ${representativeThread.customerId}
      and ${representativeCustomerIdentity.channel} = ${representativeThread.lastChannel}
      and ${representativeCustomerIdentity.externalId} = ${representativeThread.lastExternalId}
      and ${representativeCustomerIdentity.optedOutAt} is not null))`;

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
            isNull(representativeThread.limitNotedAt),
            sql`not ${leftAnswerable}`,
            sql`not ${heldWaitingQuery}`,
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
          limitNotedAt: representativeThread.limitNotedAt,
          leftForOwner: sql<boolean>`${leftAnswerable}`,
          lastReplyKind: sql<StoredReplyKind | null>`(${lastReplyKind})`,
          heldWaiting: sql<boolean>`${heldWaitingQuery}`,
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
          thread.limitNotedAt !== null ||
          thread.leftForOwner ||
          thread.heldWaiting;
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
