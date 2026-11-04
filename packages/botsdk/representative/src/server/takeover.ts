import { and, eq, gte, inArray, isNull, min, not, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  representative,
  representativeCustomer,
  representativeCustomerMerge,
  representativeThread,
  representativeThreadMessage,
  type ThreadAuthor,
} from "./db/schema";
import { passGate, storeAndDeliver } from "./outbound-gate";
import { getThread, threadNotFound } from "./owner-customers";
import { replaceDrafts, turnSender } from "./reply-drafts";
import { queueWaitingTurn } from "./thread-turns";

/*
 * An owner steps into a thread and the Representative stops (ticket #1253). Taking over cancels the
 * thread's Turn in the transaction that flips its state, under the thread's row lock, which every
 * reply takes too: a reply either landed first, or finds the thread held, or, once the owner has
 * handed back, finds its job cancelled and rolls back. Only `handBackThread` gives a thread back.
 * The thread's waiting mark outlives the takeover, as what a Turn answers after Hand back unless the
 * owner has. What goes to the Customer passes the Outbound gate first.
 */

type Context = Pick<FeatureContext, "db" | "clock" | "jobs">;

/** What a Customer gets when the owner takes their thread over. */
export const takeoverNote = "A person has joined this conversation and will reply from here.";

export const threadClosed = () =>
  rpcError("CONFLICT", "error.threadClosed", "This thread has closed");
const threadNotHeld = () =>
  rpcError("CONFLICT", "error.threadNotHeld", "Take over this thread to write in it");
export const customerBlocked = () =>
  rpcError(
    "CONFLICT",
    "error.customerBlocked",
    "This Customer is blocked, so nothing is sent to them",
  );

/**
 * Holds one of the owner's threads, or null when it isn't theirs or doesn't exist. Its Customer's
 * row first, the order the owner's block takes them in, so `blockedAt` stays true until `tx` ends.
 */
export async function tryLockThread(tx: Transaction, userId: string, threadId: string) {
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeCustomer)
    .innerJoin(
      representativeThread,
      and(
        eq(representativeThread.customerId, representativeCustomer.id),
        eq(representativeThread.id, threadId),
      ),
    )
    .innerJoin(
      representative,
      and(
        eq(representative.id, representativeThread.representativeId),
        eq(representative.userId, userId),
      ),
    )
    .where(eq(representativeCustomer.userId, userId))
    .for("share", { of: representativeCustomer });
  if (!customer) return null;
  const [thread] = await tx
    .select({
      state: representativeThread.state,
      turnId: representativeThread.turnId,
      turnFrom: representativeThread.turnFrom,
      waitingFrom: representativeThread.waitingFrom,
      lastChannel: representativeThread.lastChannel,
      lastExternalId: representativeThread.lastExternalId,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("update");
  if (!thread) return null;
  return { ...thread, blockedAt: customer.blockedAt };
}

/** Holds one of the owner's threads, or says it isn't theirs. */
export async function lockThread(tx: Transaction, userId: string, threadId: string) {
  const thread = await tryLockThread(tx, userId, threadId);
  if (!thread) throw threadNotFound();
  return thread;
}

/** Owner activity counts as the thread's, so Hand back starts its idle days; its time never moves back. */
const activeAt = (now: Date) => ({
  updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
});

type Thread = Awaited<ReturnType<typeof lockThread>>;

/**
 * Passes `text` through the Outbound gate to where the Customer was last heard, and if the gate
 * sends it, stores it and sends it. Says what the gate decided. An address that has ever been verified keeps
 * what is sent to it out of a Turn for whoever next writes from it unproven, and what is sent to one
 * that never has is that sender's to read.
 */
async function sendToCustomer(
  services: Pick<Context, "jobs">,
  tx: Transaction,
  {
    threadId,
    thread,
    author,
    text,
    now,
  }: {
    threadId: string;
    thread: Pick<Thread, "lastChannel" | "lastExternalId">;
    author: Extract<ThreadAuthor, "owner" | "note">;
    text: string;
    now: Date;
  },
) {
  const message = representativeThreadMessage;
  const channel = thread.lastChannel;
  const externalId = thread.lastExternalId;
  const [heard] = await tx
    .select({ verified: sql<boolean | null>`bool_or(${message.verified})` })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "customer"),
        eq(message.channel, channel),
        eq(message.externalId, externalId),
      ),
    );
  // No message from there stays out of unverified Turns, as a row nobody vouched for does.
  const verified = heard?.verified ?? true;
  const decision = await passGate(tx, {
    kind: author === "owner" ? "owner" : "takeover_note",
    threadId,
    to: { channel, externalId },
    now,
    content: { text, verified },
  });
  if (decision?.outcome !== "send") return decision?.outcome ?? "drop";
  await storeAndDeliver(
    services,
    tx,
    decision.id,
    { threadId, author, text, channel, externalId, verified },
    now,
  );
  return decision.outcome;
}

/**
 * Takes the thread, whose row `tx` holds, from its Representative: its Turn is aborted, whatever it
 * hasn't sent is dropped, and the Customer gets the fixed note, if the gate passes it. What that Turn or a
 * next one would have answered stays marked as waiting: a begun Turn with no reply yet moved the mark
 * past its batch, so the mark goes back to where that batch starts.
 */
export async function holdThread(
  { clock, jobs }: Pick<Context, "clock" | "jobs">,
  tx: Transaction,
  threadId: string,
  thread: Pick<Thread, "turnId" | "turnFrom" | "waitingFrom" | "lastChannel" | "lastExternalId">,
) {
  const now = clock();
  if (thread.turnId) {
    await jobs.cancelIn(tx, thread.turnId);
    // What that Turn drafted goes with it, as its batch waits again for a Turn after Hand back. A
    // Turn with no batch left has answered it, and leaves nothing to answer again.
    const sender =
      thread.turnFrom === null ? null : await turnSender(tx, threadId, thread.turnFrom);
    if (sender) await replaceDrafts(tx, threadId, now, sender);
  }
  const unanswered = thread.turnId ? thread.turnFrom : null;
  const waitingFrom =
    unanswered === null
      ? thread.waitingFrom
      : Math.min(thread.waitingFrom ?? unanswered, unanswered);
  await tx
    .update(representativeThread)
    .set({
      state: "owner",
      turnId: null,
      waitingFrom,
      waitingSince: waitingFrom === null ? null : now,
      ...activeAt(now),
    })
    .where(eq(representativeThread.id, threadId));
  await sendToCustomer({ jobs }, tx, { threadId, thread, author: "note", text: takeoverNote, now });
}

/** Takes a thread over for the owner. Taking over a thread already held does nothing. */
export async function takeOverThread(context: Context, userId: string, threadId: string) {
  await context.db.transaction(async (tx) => {
    const thread = await lockThread(tx, userId, threadId);
    if (thread.state === "closed") throw threadClosed();
    if (thread.state === "owner") return;
    await holdThread(context, tx, threadId, thread);
  });
  return getThread(context, userId, threadId);
}

/**
 * The owner's own message to the Customer, on a thread they hold. It answers what was waiting, except
 * what another address sent, since it doesn't reach them.
 */
export async function sendAsOwner(
  context: Context,
  userId: string,
  { id, text }: { id: string; text: string },
) {
  const outcome = await context.db.transaction(async (tx) => {
    const thread = await lockThread(tx, userId, id);
    if (thread.state === "closed") throw threadClosed();
    if (thread.state !== "owner") throw threadNotHeld();
    const decided = await sendToCustomer(context, tx, {
      threadId: id,
      thread,
      author: "owner",
      text,
      now: context.clock(),
    });
    // What waited to go where this just went is out of date; what waited for another address isn't.
    if (decided === "send") {
      const to = { channel: thread.lastChannel, externalId: thread.lastExternalId };
      await replaceDrafts(tx, id, context.clock(), { ...to, verified: false });
    }
    if (decided !== "send" || thread.waitingFrom === null) return decided;
    const message = representativeThreadMessage;
    const [elsewhere] = await tx
      .select({ position: min(message.position) })
      .from(message)
      .where(
        and(
          eq(message.threadId, id),
          inArray(message.author, ["customer", "bot"]),
          gte(message.position, thread.waitingFrom),
          not(
            and(
              eq(message.channel, thread.lastChannel),
              eq(message.externalId, thread.lastExternalId),
            )!,
          ),
        ),
      );
    if (elsewhere?.position) {
      await tx
        .update(representativeThread)
        .set({ waitingFrom: elsewhere.position })
        .where(eq(representativeThread.id, id));
    } else {
      await tx
        .update(representativeThread)
        .set({ waitingFrom: null, waitingSince: null })
        .where(eq(representativeThread.id, id));
    }
    return decided;
  });
  // After the commit, so the decision stays in the log.
  if (outcome !== "send") throw customerBlocked();
  return getThread(context, userId, id);
}

/** Gives a thread the owner holds, whose row `tx` holds, back: a Turn answers what still waits. */
export async function releaseThread(
  services: Context,
  tx: Transaction,
  threadId: string,
  thread: Pick<Thread, "waitingFrom">,
) {
  await tx
    .update(representativeThread)
    .set({ state: "representative", ...activeAt(services.clock()) })
    .where(eq(representativeThread.id, threadId));
  if (thread.waitingFrom !== null) await queueWaitingTurn(services, tx, threadId);
}

/**
 * Handing a thread back ends any hold a merge moved onto it: a later hold is the owner's own, which
 * undoing that merge leaves alone, and the thread the hold came from has none to get back.
 */
async function forgetMovedHold(tx: Transaction, userId: string, threadId: string) {
  const merge = representativeCustomerMerge;
  const merges = await tx
    .select({ id: merge.id, movedHolds: merge.movedHolds })
    .from(merge)
    .where(
      and(
        eq(merge.userId, userId),
        isNull(merge.undoneAt),
        sql`${merge.movedHolds} @> ${JSON.stringify([{ survivingThreadId: threadId }])}::jsonb`,
      ),
    )
    .for("update");
  for (const { id, movedHolds } of merges) {
    await tx
      .update(merge)
      .set({ movedHolds: movedHolds.filter((hold) => hold.survivingThreadId !== threadId) })
      .where(eq(merge.id, id));
  }
}

/**
 * Gives a held thread back to its Representative, and a Turn answers what still waits, if anything.
 * Handing back a thread it already holds does nothing.
 */
export async function handBackThread(context: Context, userId: string, threadId: string) {
  await context.db.transaction(async (tx) => {
    const thread = await lockThread(tx, userId, threadId);
    if (thread.state === "closed") throw threadClosed();
    if (thread.state === "representative") return;
    await forgetMovedHold(tx, userId, threadId);
    await releaseThread(context, tx, threadId, thread);
  });
  return getThread(context, userId, threadId);
}
