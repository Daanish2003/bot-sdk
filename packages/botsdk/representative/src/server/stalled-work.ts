import { and, eq, gt, inArray, max, min } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import type { ChannelOf } from "./customer-proof";
import {
  representative,
  representativeCustomer,
  representativeHandOff,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { holdForRules, passGate, storeAndDeliver } from "./outbound-gate";

/*
 * Stalled work Pages the owner (ticket #1312). Three things leave a Customer waiting with nobody
 * having said so, and each raises a Page, which needs no model call:
 * - an Assignment the Representative handed to a Bot that is still open at its due time (30 minutes
 *   unless the owner set another) is flagged overdue, and the Customer gets one fixed holding note;
 * - a Customer who has waited 2 hours on a thread the owner holds, which stays the owner's;
 * - a hand-off from a Representative with no Bot to take it (raised in `turn.ts`, each time).
 */

/** What a Customer hears when the work they were handed off for is overdue: fixed, so it costs no model call. */
export const stallNote = "Our team is still working on this and will be in touch.";

/** How long a Customer may wait on a thread the owner holds before the owner is Paged. */
export const ownerWaitMs = 2 * 60 * 60_000;

/** What a Page for an overdue Assignment, a waiting Customer and a hand-off with no Bot says raised it. */
export const assignmentOverdueCause = "assignment_overdue";
export const ownerWaitCause = "owner_wait";
export const handOffNoBotCause = "hand_off_no_bot";

type StallServices = Pick<
  FeatureContext<"assignments" | "pages">,
  "jobs" | "pages" | "assignments"
>;

export const assignmentDueJobName = "representative.assignment-due";
const assignmentDuePayload = z.object({ assignmentId: z.uuid() });

/** Queues the check of the Assignment `assignmentId` for `dueAt`, in `tx`. A repeat is a no-op. */
export async function queueAssignmentDue(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  assignmentId: string,
  dueAt: Date,
) {
  await jobs.enqueueIn(
    tx,
    { name: assignmentDueJobName, payload: assignmentDuePayload },
    { assignmentId },
    { idempotencyKey: `${assignmentDueJobName}:${assignmentId}`, runAfter: dueAt },
  );
}

/**
 * At its due time: an Assignment of a hand-off that is still open is flagged overdue, the owner is
 * Paged, and the Customer gets the holding note through the Outbound gate, if the Representative still
 * holds the thread. The flag is set once, so the Page and the note go once.
 */
export const assignmentDueJob = (channelOf: ChannelOf) =>
  defineJob<
    z.infer<typeof assignmentDuePayload>,
    FeatureContext<"assignments" | "channelAccounts" | "pages">
  >({
    name: assignmentDueJobName,
    payload: assignmentDuePayload,
    run: async ({ assignmentId }, job) => {
      await job.step("representative_assignment_due", async (tx) => {
        const handOff = representativeHandOff;
        const [row] = await tx
          .select({
            userId: representative.userId,
            representativeId: representative.id,
            name: representative.name,
            threadId: handOff.threadId,
            channel: handOff.channel,
            externalId: handOff.externalId,
            verified: handOff.verified,
          })
          .from(handOff)
          .innerJoin(representative, eq(representative.id, handOff.representativeId))
          .where(eq(handOff.assignmentId, assignmentId));
        if (!row) return;
        // The thread's locks before the Assignment's row, the order a Customer's delete takes them in.
        const hasThread = row.threadId && row.channel !== null && row.externalId !== null;
        if (row.threadId && !(await holdForRules(tx, row.threadId))) row.threadId = null;
        const { marked } = await job.assignments.markOverdue(tx, {
          userId: row.userId,
          id: assignmentId,
        });
        if (!marked) return;
        let told: "sent" | "held" | "no" = "no";
        // A test conversation's hand-off has no thread, and a delivered one has lost it.
        if (hasThread && row.threadId) {
          const now = job.clock();
          const to = { channel: row.channel!, externalId: row.externalId! };
          const noted = await passGate(tx, {
            kind: "stall_note",
            threadId: row.threadId,
            to,
            now,
            channel: channelOf(job),
            // The business speaks unprompted: quiet hours hold it until they end.
            businessStarted: true,
            jobs: job.jobs,
            content: { text: stallNote, verified: row.verified ?? false },
          });
          if (noted?.outcome === "send") {
            await storeAndDeliver(
              job,
              tx,
              noted.id,
              {
                threadId: row.threadId,
                author: "note",
                text: stallNote,
                verified: row.verified ?? false,
                ...to,
              },
              now,
            );
            told = "sent";
          } else if (noted?.outcome === "hold") {
            told = "held";
          }
        }
        await job.pages.send(tx, {
          userId: row.userId,
          cause: assignmentOverdueCause,
          urgency: "routine",
          title: "Work for a Customer is overdue",
          text: `An Assignment from ${row.name} is past its due time.${told === "sent" ? " Its Customer has been told the team is still working on it." : told === "held" ? " Its Customer's note is held for quiet hours and goes by itself when they end." : " Its Customer has not been sent a note."}`,
          path: `/representatives/${row.representativeId}`,
        });
      });
    },
  });

export const ownerWaitJobName = "representative.owner-wait";
const ownerWaitPayload = z.object({ threadId: z.uuid(), since: z.number().int() });

/** The authors whose message answers a Customer's: the owner and the Representative, not a note. */
const answering = ["owner", "representative"] as const;

/**
 * The first Customer message still waiting for an answer on `threadId`: the first after the last
 * message from the owner or the Representative.
 */
async function firstWaiting(tx: Transaction, threadId: string) {
  const message = representativeThreadMessage;
  const [answered] = await tx
    .select({ position: max(message.position) })
    .from(message)
    .where(and(eq(message.threadId, threadId), inArray(message.author, answering)));
  const [first] = await tx
    .select({ position: min(message.position) })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "customer"),
        gt(message.position, answered?.position ?? 0),
      ),
    );
  if (first?.position == null) return null;
  const [waiting] = await tx
    .select({ createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.threadId, threadId), eq(message.position, first.position)));
  return { position: first.position, since: waiting!.createdAt };
}

/**
 * Queues the Page for a Customer waiting on `threadId`, which the owner holds, in `tx`: 2 hours after
 * their first unanswered message. Every message of one wait queues the same job, so it Pages once.
 */
export async function queueOwnerWait(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  threadId: string,
  now: Date,
) {
  const waiting = await firstWaiting(tx, threadId);
  if (!waiting) return;
  const dueAt = new Date(Math.max(now.getTime(), waiting.since.getTime() + ownerWaitMs));
  await jobs.enqueueIn(
    tx,
    { name: ownerWaitJobName, payload: ownerWaitPayload },
    { threadId, since: waiting.position },
    { idempotencyKey: `${ownerWaitJobName}:${threadId}:${waiting.position}`, runAfter: dueAt },
  );
}

/**
 * Pages the owner if the Customer is still waiting: the thread is still theirs, the Customer isn't
 * blocked, and neither they nor the Representative have answered since. The thread stays the owner's.
 */
export const ownerWaitJob = defineJob<z.infer<typeof ownerWaitPayload>, StallServices>({
  name: ownerWaitJobName,
  payload: ownerWaitPayload,
  run: async ({ threadId, since }, job) => {
    await job.step("representative_owner_wait", async (tx) => {
      const [row] = await tx
        .select({
          state: representativeThread.state,
          userId: representative.userId,
          representativeId: representative.id,
          name: representative.name,
          blockedAt: representativeCustomer.blockedAt,
        })
        .from(representativeThread)
        .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
        .innerJoin(
          representativeCustomer,
          eq(representativeCustomer.id, representativeThread.customerId),
        )
        .where(eq(representativeThread.id, threadId));
      if (!row || row.state !== "owner" || row.blockedAt !== null) return;
      const waiting = await firstWaiting(tx, threadId);
      if (waiting?.position !== since) return;
      await job.pages.send(tx, {
        userId: row.userId,
        cause: ownerWaitCause,
        urgency: "routine",
        title: "A Customer is waiting for you",
        text: `A Customer has waited more than ${ownerWaitMs / 3_600_000} hours for you on a conversation with ${row.name} that you hold.`,
        path: `/representatives/${row.representativeId}`,
      });
    });
  },
});

/** Pages the owner that a hand-off had no Bot to go to, in `tx`: the Customer has been told, and the work has nowhere to go. */
export async function pageNoBot(
  { pages }: Pick<FeatureContext<"pages">, "pages">,
  tx: Transaction,
  { userId, representativeId, name }: { userId: string; representativeId: string; name: string },
) {
  await pages.send(tx, {
    userId,
    cause: handOffNoBotCause,
    urgency: "routine",
    title: "A hand-off has no Bot to go to",
    text: `${name} handed off a Customer's work, but it reports to no Bot. Choose a Bot for it, or pick the work up yourself.`,
    path: `/representatives/${representativeId}`,
  });
}
