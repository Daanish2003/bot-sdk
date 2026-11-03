import { and, eq, gt, gte, inArray, max, min, not, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  representative,
  representativeCustomer,
  representativeThread,
  representativeThreadMessage,
  type ThreadAuthor,
} from "./db/schema";
import { getThread, threadNotFound } from "./owner-customers";
import { queueWaitingTurn } from "./thread-turns";

/*
 * An owner steps into a thread and the Representative stops (ticket #1253). Taking over cancels the
 * thread's Turn in the transaction that flips its state, under the thread's row lock, which every
 * reply takes too: a reply either landed first, or finds the thread held, or, once the owner has
 * handed back, finds its job cancelled and rolls back. Only `handBackThread` gives a thread back.
 * The thread's waiting mark outlives the takeover, as what a Turn answers after Hand back unless the
 * owner has. What goes to the Customer is stored as sent: nothing reaches a real Channel until the
 * gate spec.
 */

type Context = Pick<FeatureContext, "db" | "clock" | "jobs">;

/** What a Customer gets when the owner takes their thread over. */
export const takeoverNote = "A person has joined this conversation and will reply from here.";

const threadClosed = () => rpcError("CONFLICT", "error.threadClosed", "This thread has closed");
const threadNotHeld = () =>
  rpcError("CONFLICT", "error.threadNotHeld", "Take over this thread to write in it");
const customerBlocked = () =>
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
async function lockThread(tx: Transaction, userId: string, threadId: string) {
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
 * Sends `text` to where the Customer was last heard. An address that has ever been verified keeps
 * what is sent to it out of a Turn for whoever next writes from it unproven, and what is sent to one
 * that never has is that sender's to read.
 */
async function sendToCustomer(
  tx: Transaction,
  {
    threadId,
    thread,
    author,
    text,
    now,
  }: {
    threadId: string;
    thread: Thread;
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
  const [updated] = await tx
    .update(representativeThread)
    .set({ messageCount: sql`${representativeThread.messageCount} + 1`, ...activeAt(now) })
    .where(eq(representativeThread.id, threadId))
    .returning({ position: representativeThread.messageCount });
  await tx.insert(message).values({
    id: uuidv7(),
    threadId,
    position: updated!.position,
    author,
    text,
    channel,
    externalId,
    // No message from there stays out of unverified Turns, as a row nobody vouched for does.
    verified: heard?.verified ?? true,
  });
}

/**
 * The oldest of the Customer's messages after the last reply or word from the owner, which is what a
 * begun Turn was answering. A note answers nothing.
 */
async function oldestUnanswered(tx: Transaction, threadId: string) {
  const message = representativeThreadMessage;
  const [answered] = await tx
    .select({ position: max(message.position) })
    .from(message)
    .where(
      and(eq(message.threadId, threadId), inArray(message.author, ["representative", "owner"])),
    );
  const [unanswered] = await tx
    .select({ position: min(message.position) })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        inArray(message.author, ["customer", "bot"]),
        gt(message.position, answered?.position ?? 0),
      ),
    );
  return unanswered?.position ?? null;
}

/**
 * Takes the thread from its Representative: its Turn is aborted, whatever it hasn't sent is dropped,
 * and the Customer gets the fixed note, unless blocked. What that Turn or a next one would have
 * answered stays marked as waiting. Taking over a thread already held does nothing.
 */
export async function takeOverThread(context: Context, userId: string, threadId: string) {
  await context.db.transaction(async (tx) => {
    const thread = await lockThread(tx, userId, threadId);
    if (thread.state === "closed") throw threadClosed();
    if (thread.state === "owner") return;
    if (thread.turnId) await context.jobs.cancelIn(tx, thread.turnId);
    const now = context.clock();
    const waitingFrom =
      thread.waitingFrom ??
      (thread.turnId && !thread.blockedAt ? await oldestUnanswered(tx, threadId) : null);
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
    if (!thread.blockedAt) {
      await sendToCustomer(tx, { threadId, thread, author: "note", text: takeoverNote, now });
    }
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
  await context.db.transaction(async (tx) => {
    const thread = await lockThread(tx, userId, id);
    if (thread.state === "closed") throw threadClosed();
    if (thread.state !== "owner") throw threadNotHeld();
    if (thread.blockedAt) throw customerBlocked();
    await sendToCustomer(tx, {
      threadId: id,
      thread,
      author: "owner",
      text,
      now: context.clock(),
    });
    if (thread.waitingFrom === null) return;
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
  });
  return getThread(context, userId, id);
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
    await tx
      .update(representativeThread)
      .set({ state: "representative", ...activeAt(context.clock()) })
      .where(eq(representativeThread.id, threadId));
    if (thread.waitingFrom !== null) await queueWaitingTurn(context, tx, threadId);
  });
  return getThread(context, userId, threadId);
}
