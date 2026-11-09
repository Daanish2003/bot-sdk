import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { maxThreadMessageLength, noNul } from "../shared/contract";
import { transcriptText } from "./call-transcript";
import { smsChannel } from "./customer-proof";
import {
  representative,
  representativeCall,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { replaceHeld } from "./reply-drafts";
import { queueOwnerWait } from "./stalled-work";
import { activeAt, tryLockThread } from "./takeover";
import { wakeTurn } from "./thread-turns";
import { callIdField, voiceHookRoute, type VoiceHookAccount } from "./voice-hook";

/*
 * Call end (ticket #1384, ADR 0036): a Voice agent posts the transcript, which joins the Customer's
 * thread as one `call` entry. It isn't a Customer's message: what a Voice agent reports proves nothing
 * and goes through no check for a code, since a code read aloud must not pass as proof. To every counter
 * it is the Customer's word, and it wakes a Turn to review it (ticket #1385). The Call's status makes a
 * repeat harmless. One too long for a thread message loses its end.
 */

const callEndBody = z.object({
  callId: callIdField,
  transcript: z.array(
    z.object({
      role: z.enum(["caller", "agent"]),
      text: z.string().refine(noNul),
    }),
  ),
});

/**
 * Adds a finished Call to its thread as one entry, in `tx`, once its status has changed, so a repeat
 * adds nothing, and wakes the Turn that reviews it, as a Bot's result does. On a thread the owner took
 * over the entry waits for them and no Turn runs; a blocked or opted-out caller gets no Turn either.
 */
async function addCallEntry(
  services: Pick<FeatureContext, "db" | "clock" | "jobs">,
  tx: Transaction,
  thread: NonNullable<Awaited<ReturnType<typeof tryLockThread>>>,
  call: { threadId: string; externalId: string; userId: string },
  { messageId, text, now }: { messageId: string; text: string; now: Date },
) {
  const { threadId, externalId } = call;
  const nowSql = sql`${now.toISOString()}::timestamp`;
  const [identity] = await tx
    .select({ optedOutAt: representativeCustomerIdentity.optedOutAt })
    .from(representativeCustomerIdentity)
    .where(
      and(
        eq(representativeCustomerIdentity.userId, call.userId),
        eq(representativeCustomerIdentity.channel, smsChannel),
        eq(representativeCustomerIdentity.externalId, externalId),
      ),
    );
  const wakes = thread.state === "representative" && !thread.blockedAt && !identity?.optedOutAt;
  const [updated] = await tx
    .update(representativeThread)
    .set({
      messageCount: sql`${representativeThread.messageCount} + 1`,
      ...(thread.state !== "closed" && activeAt(now)),
      ...(wakes && {
        waitingFrom: sql`coalesce(${representativeThread.waitingFrom}, ${representativeThread.messageCount} + 1)`,
        waitingSince: sql`coalesce(${representativeThread.waitingSince}, ${nowSql})`,
      }),
    })
    .where(eq(representativeThread.id, threadId))
    .returning({
      position: representativeThread.messageCount,
      waitingSince: representativeThread.waitingSince,
    });
  await tx.insert(representativeThreadMessage).values({
    id: messageId,
    threadId,
    position: updated!.position,
    author: "call",
    text,
    // Every caller is unverified: the number is only what the vendor reports.
    verified: false,
    heldForOwner: thread.state === "owner",
    channel: smsChannel,
    externalId,
    createdAt: now,
  });
  // A draft meant for them is out of date, as when they write.
  await replaceHeld(tx, threadId, now, { channel: smsChannel, externalId, verified: false });
  if (wakes) {
    await wakeTurn(services, tx, {
      threadId,
      turnId: thread.turnId,
      waitingSince: updated!.waitingSince!,
    });
  } else if (thread.state === "owner") {
    await queueOwnerWait(services, tx, threadId, now);
  }
}

/** Ends the Call `callId` on `account` with its transcript. An unknown or finished Call changes nothing. */
async function endCall(
  context: FeatureContext,
  account: VoiceHookAccount,
  { callId, transcript }: z.infer<typeof callEndBody>,
) {
  const now = context.clock();
  await context.db.transaction(async (tx) => {
    const [call] = await tx
      .select({
        id: representativeCall.id,
        threadId: representativeCall.threadId,
        externalId: representativeCall.externalId,
        userId: representative.userId,
      })
      .from(representativeCall)
      .innerJoin(representative, eq(representative.id, account.representativeId))
      .where(
        and(
          eq(representativeCall.channelAccountId, account.id),
          eq(representativeCall.callId, callId),
        ),
      );
    if (!call) return;
    // The caller's Customer before their thread, as for a message: a delete holds it, then looks for
    // their words on every thread, and the status below finds a Call that delete has taken.
    const [caller] = await tx
      .select({ customerId: representativeCustomerIdentity.customerId })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, call.userId),
          eq(representativeCustomerIdentity.channel, smsChannel),
          eq(representativeCustomerIdentity.externalId, call.externalId),
        ),
      );
    if (caller) {
      await tx
        .select({ id: representativeCustomer.id })
        .from(representativeCustomer)
        .where(eq(representativeCustomer.id, caller.customerId))
        .for("key share");
    }
    // The thread's lock first, as a delete and a merge take it before the rows under it.
    const thread = await tryLockThread(tx, call.userId, call.threadId);
    if (!thread) return;
    const messageId = uuidv7();
    const [ended] = await tx
      .update(representativeCall)
      .set({ status: "ended", endedAt: now, messageId })
      .where(and(eq(representativeCall.id, call.id), eq(representativeCall.status, "in_progress")))
      .returning({ id: representativeCall.id });
    if (!ended) return;
    await addCallEntry(context, tx, thread, call, {
      messageId,
      text: transcriptText(transcript).slice(0, maxThreadMessageLength),
      now,
    });
  });
  return { ok: true };
}

export const callEndRoutes = [voiceHookRoute("end", callEndBody, endCall)];
