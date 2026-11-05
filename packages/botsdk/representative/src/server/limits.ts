import { and, eq, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { limitNoteKind } from "../shared/replies";
import { type Heard, storeReply } from "./customers";
import { representativeThread } from "./db/schema";
import { holdForRules, type GateRefusal, type ViaChannel } from "./outbound-gate";
import { leaveOldMessages, queueWaitingTurn } from "./thread-turns";

/*
 * A Representative at a limit (ticket #1309). A Turn that finds a limit reached makes no model call:
 * the Customer gets one fixed note, what they said stays owed, and the owner is Paged. Nothing tells a
 * thread that a limit lifted, so each thread at one keeps a delayed job that looks again. When it has
 * lifted, a Turn answers what is under 24 hours old, and what is older is left for the owner. A Bot at
 * a limit isn't this: only a Representative's Turn comes here.
 */

/** What a Customer hears at a limit: fixed, so it costs no model call and promises only the owner's reply. */
export const limitNote = "Our team has your message and will reply.";

/** Which limit was reached, as its Page's cause: the owner hears of each at most once a day. */
const limitPages = {
  quota_spent: {
    title: "Your Quota is spent",
    text: "Your Representative can't answer Customers until your Quota lifts. Each has a note saying your team will reply. When it lifts, messages under 24 hours old are answered automatically, and older ones are left for you.",
  },
  thread_cap: {
    title: "A conversation reached its spending cap",
    text: "A conversation used all the model calls or money you allow it. Each Customer it held back has a note saying your team will reply. When it lifts, messages under 24 hours old are answered automatically, and older ones are left for you.",
  },
  customer_cap: {
    title: "A Customer reached the daily spending cap",
    text: "A Customer used all the model calls or money you allow one in a day. Each Customer it held back has a note saying your team will reply. When it lifts, messages under 24 hours old are answered automatically, and older ones are left for you.",
  },
  stranger_cap: {
    title: "An unverified Customer reached the daily spending cap",
    text: "A Customer whose identity wasn't checked used all the model calls or money you allow one in a day. Each Customer it held back has a note saying your team will reply. When it lifts, messages under 24 hours old are answered automatically, and older ones are left for you.",
  },
  month_cap: {
    title: "Your Representative reached its monthly spending cap",
    text: "Your Representative spent all you allow it this month, which keeps your Quota for your own Bots. Each Customer it held back has a note saying your team will reply. When it lifts, messages under 24 hours old are answered automatically, and older ones are left for you.",
  },
};
export type LimitCause = keyof typeof limitPages;

export const limitCheckJobName = "representative.limit-check";

export const limitCheckPayload = z.object({ threadId: z.uuid() });

const hourMs = 60 * 60_000;

/**
 * Queues the next look at a thread at a limit, in `tx`, for the next hour on the clock, when a Quota's
 * window resets. Keyed by that hour: more than one chain for a thread comes down to one.
 */
export async function queueLimitCheck(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  threadId: string,
  now: Date,
) {
  const dueAt = new Date((Math.floor(now.getTime() / hourMs) + 1) * hourMs);
  await jobs.enqueueIn(
    tx,
    { name: limitCheckJobName, payload: limitCheckPayload },
    { threadId },
    { idempotencyKey: `${limitCheckJobName}:${threadId}:${dueAt.getTime()}`, runAfter: dueAt },
  );
}

/**
 * Looks again now at every thread of `representativeId` at a limit, in `tx`: the owner raised a cap,
 * which may have lifted it. Their hourly chains go on as they were.
 */
export async function checkLimitsNow(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  representativeId: string,
  now: Date,
) {
  const limited = await tx
    .select({ id: representativeThread.id })
    .from(representativeThread)
    .where(
      and(
        eq(representativeThread.representativeId, representativeId),
        isNotNull(representativeThread.limitNotedAt),
      ),
    );
  for (const { id } of limited) {
    await jobs.enqueueIn(
      tx,
      { name: limitCheckJobName, payload: limitCheckPayload },
      { threadId: id },
      { idempotencyKey: `${limitCheckJobName}:${id}:raised:${now.getTime()}`, runAfter: now },
    );
  }
}

/**
 * Turn `turnId` found `cause`'s limit reached before any model call. Its batch goes back to waiting,
 * with no Turn on the way, and the sender it answers gets the note through the Outbound gate, if the
 * thread hasn't had one at this limit. A thread that has left this Turn gets nothing.
 */
export async function reachLimit(
  services: Pick<FeatureContext<"pages">, "jobs" | "pages"> & ViaChannel,
  tx: Transaction,
  {
    userId,
    representativeId,
    turnId,
    thread,
    cause,
    now,
  }: {
    userId: string;
    representativeId: string;
    turnId: string;
    thread: {
      threadId: string;
      upTo: number;
      heard: Heard;
      verified: boolean;
      releaseId: string;
      refusals: GateRefusal[];
    };
    cause: LimitCause;
    now: Date;
  },
) {
  const { threadId } = thread;
  if (!(await holdForRules(tx, threadId))) return;
  const [row] = await tx
    .select({
      turnId: representativeThread.turnId,
      turnFrom: representativeThread.turnFrom,
      waitingFrom: representativeThread.waitingFrom,
      limitNotedAt: representativeThread.limitNotedAt,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId));
  if (row?.turnId !== turnId) return;
  // A note the gate refused hasn't gone, so a later Turn at this limit tries again.
  const noted =
    row.limitNotedAt === null &&
    !(
      "error" in
      (await storeReply(services, tx, thread, { text: limitNote, sources: [] }, limitNoteKind, now))
    );
  const { turnFrom, waitingFrom } = row;
  await tx
    .update(representativeThread)
    .set({
      limitNotedAt: row.limitNotedAt ?? (noted ? now : null),
      turnFrom: null,
      waitingFrom: turnFrom === null ? waitingFrom : Math.min(waitingFrom ?? turnFrom, turnFrom),
      waitingSince: null,
    })
    .where(eq(representativeThread.id, threadId));
  // Each time, not only with the note: a chain whose last check failed for good starts again here. With
  // no note too, one the gate refused: nothing else looks at what waits until the Customer writes again.
  await queueLimitCheck(services, tx, threadId, now);
  await services.pages.sendDaily(tx, {
    userId,
    cause,
    urgency: "routine",
    ...limitPages[cause],
    path: `/representatives/${representativeId}`,
  });
}

/**
 * The Representative of a thread still at a limit, for its check; null ends the chain. A thread whose
 * note the gate refused shows it by what waits with no Turn on the way.
 */
export async function limitedThread(tx: Transaction, threadId: string) {
  const [row] = await tx
    .select({ representativeId: representativeThread.representativeId })
    .from(representativeThread)
    .where(
      and(
        eq(representativeThread.id, threadId),
        or(
          isNotNull(representativeThread.limitNotedAt),
          and(isNotNull(representativeThread.waitingFrom), isNull(representativeThread.turnId)),
        ),
      ),
    );
  return row ?? null;
}

/**
 * What a thread's check found. Lifted, and with no Turn on the thread, what is under 24 hours old gets
 * a Turn and what is older stays for the owner; on a thread the owner holds, it waits for Hand back.
 * Otherwise the chain looks again: a Turn on the thread ends the limit itself, or finds it reached and
 * stays on it.
 */
export async function settleLimit(
  services: Pick<FeatureContext, "db" | "clock" | "jobs">,
  tx: Transaction,
  threadId: string,
  lifted: boolean,
  now: Date,
) {
  const [row] = await tx
    .select({
      state: representativeThread.state,
      turnId: representativeThread.turnId,
      waitingFrom: representativeThread.waitingFrom,
      limitNotedAt: representativeThread.limitNotedAt,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("update");
  if (!row || row.state === "closed") return;
  if (row.limitNotedAt === null && row.waitingFrom === null) return;
  if (!lifted || row.turnId !== null) {
    await queueLimitCheck(services, tx, threadId, now);
    return;
  }
  const answering =
    row.waitingFrom === null ? null : await leaveOldMessages(tx, threadId, row.waitingFrom, now);
  await tx
    .update(representativeThread)
    .set({
      limitNotedAt: null,
      waitingFrom: answering,
      ...(answering === null && { waitingSince: null }),
    })
    .where(eq(representativeThread.id, threadId));
  if (answering !== null && row.state === "representative") {
    await queueWaitingTurn(services, tx, threadId);
  }
}

/**
 * Turn `turnId` ran no loop at all, as its Representative can't start, on a thread at a limit: what
 * it took stays owed, since the Customer has been told someone will reply.
 */
export async function keepLimitBatch(tx: Transaction, threadId: string, turnId: string) {
  const thread = representativeThread;
  await tx
    .update(thread)
    .set({
      waitingFrom: sql`least(${thread.waitingFrom}, ${thread.turnFrom})`,
      waitingSince: null,
      turnFrom: null,
    })
    .where(
      and(
        eq(thread.id, threadId),
        eq(thread.turnId, turnId),
        isNotNull(thread.limitNotedAt),
        not(isNull(thread.turnFrom)),
      ),
    );
}

/** Turn `turnId` got past the limit check, so the thread isn't at a limit any more. */
export async function limitPassed(tx: Transaction, threadId: string, turnId: string) {
  await tx
    .update(representativeThread)
    .set({ limitNotedAt: null })
    .where(
      and(
        eq(representativeThread.id, threadId),
        eq(representativeThread.turnId, turnId),
        isNotNull(representativeThread.limitNotedAt),
      ),
    );
}
