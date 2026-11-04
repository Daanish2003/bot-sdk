import { and, asc, eq, gt, gte, inArray, isNotNull, min, sql } from "drizzle-orm";
import { z } from "zod";

import { batchLongestMs, batchQuietMs } from "@botsdk/bot/bot/triggers";
import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { job } from "@botsdk/bot/storage";
import { maxThreadMessageLength, noNul } from "../shared/contract";
import {
  holdThreadCustomer,
  receiveMessage,
  threadPromptChars,
  threadPromptLimit,
} from "./customers";
import {
  representative,
  representativeCustomer,
  representativeThread,
  representativeThreadMessage,
  representativeTurn,
} from "./db/schema";
import { queueIdleCheck } from "./idle";
import { waitingAfterAbort } from "./takeover";
import { channelProof } from "./verification";

/*
 * One Turn at a time on a Customer thread, with quick messages batched (ticket #1250). A message is
 * stored as it arrives. The thread's row says which Turn holds it and since when messages have
 * waited for one, and every change to those takes the row's lock, so an arriving message and a Turn
 * beginning or ending see each other. A Turn reads the messages that were there when it began.
 *
 * A batch has one sender, verified or not throughout, and fits what a Turn reads. It closes at the
 * first message that breaks either, which waits for the next Turn, so each sender's Turn replies to
 * that sender alone, and no batched message is dropped unread.
 */

type Services = Pick<FeatureContext, "db" | "clock" | "jobs">;

export const representativeTurnJobName = "representative.turn";

/** A Turn's job, as the thread queues it: the thread and its Turn, never a message or a Customer. */
export const turnJobPayload = z.object({ threadId: z.uuid(), turnId: z.uuid() });
export type TurnJobPayload = z.infer<typeof turnJobPayload>;

const turnJob = { name: representativeTurnJobName, payload: turnJobPayload };

/** When a batch waiting since `since` closes: as the Router's do, however long messages go on. */
const batchClosesAt = (since: Date, now: Date) =>
  new Date(Math.min(now.getTime() + batchQuietMs, since.getTime() + batchLongestMs));

/** The runner only polls for a job due later, so it is woken then. A tx that rolls back wakes it for nothing. */
function wakeAt({ clock, jobs }: Services, runAfter: Date) {
  const delay = runAfter.getTime() - clock().getTime();
  if (delay > 0) setTimeout(() => jobs.wake(), delay).unref?.();
}

/** Gives the thread, whose row `tx` holds, to a new Turn, whose job's key is its id. */
async function startTurn(services: Services, tx: Transaction, threadId: string, runAfter: Date) {
  const turnId = uuidv7();
  await tx
    .update(representativeThread)
    .set({ turnId, turnFrom: null })
    .where(eq(representativeThread.id, threadId));
  wakeAt(services, runAfter);
  return services.jobs.enqueueIn(
    tx,
    turnJob,
    { threadId, turnId },
    { idempotencyKey: turnId, runAfter },
  );
}

const customerMessage = z.object({
  representativeId: z.uuid(),
  /** Who sent it. The Customer's id is code's, from this identity: a Model never names one. */
  channel: z.string().min(1).max(64).refine(noNul),
  externalId: z.string().min(1).max(512).refine(noNul),
  /** What the Channel's Customer path says of the sender; a Channel with no rule says nothing. */
  proof: channelProof.optional(),
  message: z.string().min(1).max(maxThreadMessageLength).refine(noNul),
});
export type CustomerMessage = z.infer<typeof customerMessage>;

/**
 * Takes a Customer's message: stores it on its thread, and has a Turn answer it. Null when the
 * Representative doesn't exist and nothing was stored. Otherwise `jobId` is the job of the Turn now
 * holding the thread, which a later Turn follows if it has already begun, or null when the message
 * is kept with no Turn: a blocked Customer's, or one on a thread the owner holds.
 * No route, RPC or API method reaches this: until a later spec lets real Customers in, only the test
 * Customer entry point in the private `@ai-chat/test-support` package does.
 */
export async function receiveCustomerMessage(
  services: Services & Pick<FeatureContext, "keyring">,
  given: CustomerMessage,
) {
  const { representativeId, channel, externalId, proof, message } = customerMessage.parse(given);
  return services.db.transaction(async (tx) => {
    const now = services.clock();
    const received = await receiveMessage(tx, {
      services,
      representativeId,
      heard: { channel, externalId },
      proof,
      text: message,
      now,
    });
    if (!received) return null;
    const { threadId, turnId, waitingSince, blocked, state, opened } = received;
    // With the message, so a thread is never left without its closing job.
    if (opened) await queueIdleCheck(services, tx, threadId, now);
    // Kept for the owner, and nothing more: no model call, no reply and no Assignment.
    if (blocked) return { jobId: null };
    // It waits for the owner, or for Hand back: no model call runs while they hold the thread.
    if (state === "owner") return { jobId: null };
    return {
      jobId: await wakeTurn(services, tx, { threadId, turnId, waitingSince: waitingSince! }),
    };
  });
}

/**
 * Has a Turn answer what waits on the thread, whose row `tx` holds, since `waitingSince`: the job of
 * the Turn now holding it. `turnId` is the Turn that held it already, if any.
 */
export async function wakeTurn(
  services: Services,
  tx: Transaction,
  {
    threadId,
    turnId,
    waitingSince,
  }: { threadId: string; turnId: string | null; waitingSince: Date },
) {
  const runAfter = batchClosesAt(waitingSince, services.clock());
  if (!turnId) return startTurn(services, tx, threadId, runAfter);
  // Its job hasn't started: this message joins the batch, and moves when it closes.
  const payload = { threadId, turnId };
  const replaced = await services.jobs.replaceIfNotStarted(tx, turnId, turnJob, payload, {
    runAfter,
  });
  if (replaced) {
    wakeAt(services, runAfter);
    return replaced;
  }
  // Its job is running: if the Turn has begun, the message waits for the next one. Something else
  // may have ended that job without ending the Turn; a new Turn takes over, so no thread sticks,
  // and the old job's late `onFailed` can't touch it.
  const [running] = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.idempotencyKey, turnId), inArray(job.status, ["queued", "running"])));
  return running?.id ?? (await startTurn(services, tx, threadId, runAfter));
}

/**
 * Has a new Turn answer what waits on the thread, whose row `tx` holds, as if it had just arrived.
 * For a thread handed back, whose messages waited through the owner's hold.
 */
export async function queueWaitingTurn(services: Services, tx: Transaction, threadId: string) {
  const now = services.clock();
  await tx
    .update(representativeThread)
    .set({ waitingSince: now })
    .where(eq(representativeThread.id, threadId));
  await startTurn(services, tx, threadId, batchClosesAt(now, now));
}

/** How old a message that waited through a limit may be and still get an automatic answer. */
export const limitAnswerMs = 24 * 60 * 60_000;

/**
 * What of the messages waiting from `waitingFrom` is still young enough to be answered after a limit:
 * the position of the oldest that is, or null. What is older is left for the owner (ticket #1309).
 */
export async function leaveOldMessages(
  tx: Transaction,
  threadId: string,
  waitingFrom: number,
  now: Date,
) {
  const message = representativeThreadMessage;
  const [fresh] = await tx
    .select({ position: min(message.position) })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        inArray(message.author, ["customer", "bot"]),
        gte(message.position, waitingFrom),
        gte(message.createdAt, new Date(now.getTime() - limitAnswerMs)),
      ),
    );
  const position = fresh?.position ?? null;
  if (position !== waitingFrom) {
    await tx
      .update(representativeThread)
      .set({ leftForOwnerAt: now })
      .where(eq(representativeThread.id, threadId));
  }
  return position;
}

/**
 * Where the batch starting at `rows`' first closes: at the row that breaks it, or at the end of the
 * thread when none does. Sizes are in bytes, which a message's length in a Turn's read never exceeds.
 */
function closeBatch(
  rows: {
    position: number;
    author: string;
    channel: string;
    externalId: string;
    verified: boolean;
    size: number;
  }[],
) {
  const first = rows[0]!;
  let chars = 0;
  return rows.find((row, index) => {
    chars += row.size;
    // A Bot's result is answered to the sender it was handed off for, so it is a sender's too.
    const otherSender =
      (row.author === "customer" || row.author === "bot") &&
      (row.channel !== first.channel ||
        row.externalId !== first.externalId ||
        row.verified !== first.verified);
    return index > 0 && (index >= threadPromptLimit || chars > threadPromptChars || otherSender);
  });
}

/**
 * Begins Turn `turnId` in its job's first Checkpoint: its batch closes, so what is past it waits for
 * the next Turn. What it returns is what a replay goes by: a place in the thread, not who or what was
 * said, since user delete doesn't reach a Checkpoint. Null, running no Turn, when the thread has gone,
 * another Turn holds it, or nothing is left for a Turn to answer: nothing waits any more, the Customer
 * is blocked, or the Representative no longer holds the thread. What waited then gets no Turn. On a
 * thread at a limit, what has grown too old to answer is left out, whether or not this Turn gets past it.
 */
export async function beginTurn(tx: Transaction, threadId: string, turnId: string, now: Date) {
  const [thread] = await tx
    .select({
      customerId: representativeThread.customerId,
      representativeId: representativeThread.representativeId,
      messageCount: representativeThread.messageCount,
      waitingFrom: representativeThread.waitingFrom,
      state: representativeThread.state,
      limitNotedAt: representativeThread.limitNotedAt,
      blockedAt: representativeCustomer.blockedAt,
    })
    .from(representativeThread)
    .innerJoin(
      representativeCustomer,
      eq(representativeCustomer.id, representativeThread.customerId),
    )
    .where(and(eq(representativeThread.id, threadId), eq(representativeThread.turnId, turnId)))
    .for("update", { of: representativeThread });
  if (!thread) return null;
  const inThread = eq(representativeThread.id, threadId);
  const { customerId, representativeId, messageCount, state, limitNotedAt, blockedAt } = thread;
  const stopped = thread.waitingFrom === null || blockedAt || state !== "representative";
  const waitingFrom =
    !stopped && limitNotedAt
      ? await leaveOldMessages(tx, threadId, thread.waitingFrom!, now)
      : thread.waitingFrom;
  if (stopped || waitingFrom === null) {
    await tx
      .update(representativeThread)
      .set({ turnId: null, waitingFrom: null, waitingSince: null })
      .where(inThread);
    return null;
  }
  const message = representativeThreadMessage;
  const rows = await tx
    .select({
      position: message.position,
      author: message.author,
      channel: message.channel,
      externalId: message.externalId,
      verified: message.verified,
      size: sql<number>`octet_length(${message.text})`,
    })
    .from(message)
    .where(and(eq(message.threadId, threadId), gte(message.position, waitingFrom)))
    .orderBy(asc(message.position))
    .limit(threadPromptLimit + 1);
  const pastBatch = closeBatch(rows);
  const upTo = pastBatch ? pastBatch.position - 1 : messageCount;
  const [next] = pastBatch
    ? await tx
        .select({ position: min(message.position) })
        .from(message)
        .where(
          and(
            eq(message.threadId, threadId),
            inArray(message.author, ["customer", "bot"]),
            gt(message.position, upTo),
          ),
        )
    : [];
  await tx
    .update(representativeThread)
    .set({
      turnFrom: rows[0]!.position,
      ...(next?.position
        ? { waitingFrom: next.position }
        : { waitingFrom: null, waitingSince: null }),
    })
    .where(inThread);
  // Kept for what its model calls cost (ticket #1310); a retried Turn is the same row.
  await tx
    .insert(representativeTurn)
    .values({ id: turnId, threadId, representativeId })
    .onConflictDoNothing();
  return {
    customerId,
    representativeId,
    upTo,
    senderAt: rows[0]!.position,
    verified: rows[0]!.verified,
  };
}

/** Ends Turn `turnId`, if it still holds the thread: the next Turn takes what has waited, if anything has. */
export async function endTurn(
  services: Services,
  tx: Transaction,
  threadId: string,
  turnId: string,
) {
  const [thread] = await tx
    .select({ waitingSince: representativeThread.waitingSince })
    .from(representativeThread)
    .where(and(eq(representativeThread.id, threadId), eq(representativeThread.turnId, turnId)))
    .for("update");
  if (!thread) return;
  if (thread.waitingSince) {
    const runAfter = batchClosesAt(thread.waitingSince, services.clock());
    await startTurn(services, tx, threadId, runAfter);
    return;
  }
  await tx
    .update(representativeThread)
    .set({ turnId: null })
    .where(eq(representativeThread.id, threadId));
}

/** The owner of the thread, or null once it has gone. */
export async function threadOwner(tx: Transaction, threadId: string) {
  const [row] = await tx
    .select({ userId: representative.userId })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId));
  return row?.userId ?? null;
}

/**
 * Lets Turn `turnId` go without running, because its owner is Banned (ticket #1299): the thread holds
 * no Turn, and what waited on it stays marked as waiting, for the next Customer message after the
 * Ban. Nothing starts a Turn meanwhile, which `endTurn` would.
 */
export async function dropBannedTurn(tx: Transaction, threadId: string, turnId: string) {
  await tx
    .update(representativeThread)
    .set({ turnId: null })
    .where(and(eq(representativeThread.id, threadId), eq(representativeThread.turnId, turnId)));
}

/**
 * A Ban on `userId`: every Turn on their threads is cancelled, a running one too, and the threads
 * hold none. What a begun Turn hadn't answered goes back to waiting, as when the owner takes a
 * thread over. One thread to a transaction, its Customer's row first, the order a merge and a delete
 * take them in.
 */
export async function stopUserTurns(
  { db, clock, jobs }: Pick<Services, "db" | "clock" | "jobs">,
  userId: string,
) {
  const thread = representativeThread;
  const held = await db
    .select({ id: thread.id })
    .from(thread)
    .innerJoin(representative, eq(representative.id, thread.representativeId))
    .where(and(eq(representative.userId, userId), isNotNull(thread.turnId)))
    .orderBy(thread.id);
  for (const { id } of held) {
    await db.transaction(async (tx) => {
      await holdThreadCustomer(tx, id);
      const [now] = await tx.select().from(thread).where(eq(thread.id, id)).for("update");
      if (!now?.turnId) return;
      await jobs.cancelIn(tx, now.turnId);
      await tx
        .update(thread)
        .set({ turnId: null, ...waitingAfterAbort(now, clock()) })
        .where(eq(thread.id, id));
    });
  }
}
