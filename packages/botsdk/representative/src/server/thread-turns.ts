import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { batchLongestMs, batchQuietMs } from "@botsdk/bot/bot/triggers";
import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { job } from "@botsdk/bot/storage";
import { noNul } from "../shared/contract";
import { maxThreadMessageLength, receiveMessage } from "./customers";
import { representativeThread } from "./db/schema";

/*
 * One Turn at a time on a Customer thread, with quick messages batched (ticket #1250). A message is
 * stored as it arrives. The thread's row says which Turn holds it and since when messages have
 * waited for one, and every change to those takes the row's lock, so an arriving message and a Turn
 * beginning or ending see each other. A Turn reads the messages that were there when it began.
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
    .set({ turnId })
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
  message: z.string().min(1).max(maxThreadMessageLength).refine(noNul),
});
export type CustomerMessage = z.infer<typeof customerMessage>;

/**
 * Takes a Customer's message: stores it on its thread, and has a Turn answer it. Returns the job of
 * the Turn now holding the thread, which a later Turn follows if it has already begun, or null when
 * the Representative doesn't exist and nothing was stored.
 * No route, RPC or API method reaches this: until a later spec lets real Customers in, only the test
 * Customer entry point in the private `@ai-chat/test-support` package does.
 */
export async function receiveCustomerMessage(services: Services, given: CustomerMessage) {
  const { representativeId, channel, externalId, message } = customerMessage.parse(given);
  return services.db.transaction(async (tx) => {
    const now = services.clock();
    const received = await receiveMessage(tx, {
      representativeId,
      heard: { channel, externalId },
      text: message,
      now,
    });
    if (!received) return null;
    const { threadId, turnId, waitingSince } = received;
    const runAfter = batchClosesAt(waitingSince, now);
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
    return running?.id ?? startTurn(services, tx, threadId, runAfter);
  });
}

/**
 * Begins Turn `turnId` in its job's first Checkpoint: the batch closes, so what arrives from here on
 * waits for the next Turn. What it returns is what a replay reads again. Null when the thread has
 * gone or another Turn holds it.
 */
export async function beginTurn(tx: Transaction, threadId: string, turnId: string) {
  const [thread] = await tx
    .update(representativeThread)
    .set({ waitingSince: null })
    .where(and(eq(representativeThread.id, threadId), eq(representativeThread.turnId, turnId)))
    .returning({
      customerId: representativeThread.customerId,
      representativeId: representativeThread.representativeId,
      upTo: representativeThread.messageCount,
    });
  return thread ?? null;
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
