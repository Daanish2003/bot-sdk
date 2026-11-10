import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { maxThreadMessageLength, noNul, type RecordedRequest } from "../shared/contract";
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

/** A Call as the end finds it, before its locks: its thread, its caller's number then, and its owner. */
export type CallToEnd = {
  id: string;
  threadId: string;
  externalId: string;
  identityId: string | null;
  userId: string;
};

/**
 * Who made the Call: the identity it points at, whatever that identity's address is now. Only a Call
 * kept before that reference goes by the number, if the owner knows it.
 */
async function callerOf(
  tx: Transaction,
  userId: string,
  identityId: string | null,
  externalId: string,
) {
  const [caller] = await tx
    .select({
      customerId: representativeCustomerIdentity.customerId,
      optedOutAt: representativeCustomerIdentity.optedOutAt,
    })
    .from(representativeCustomerIdentity)
    .where(
      identityId
        ? eq(representativeCustomerIdentity.id, identityId)
        : and(
            eq(representativeCustomerIdentity.userId, userId),
            eq(representativeCustomerIdentity.channel, smsChannel),
            eq(representativeCustomerIdentity.externalId, externalId),
          ),
    );
  return caller;
}

/**
 * Closes `call` in `tx` with its `call` entry reading what `text` makes of its requests, read under the
 * locks so none that landed during the wait is lost, and says whether its caller is blocked; false when
 * it adds nothing, as a Call already closed or whose thread a delete has taken does. Every end goes
 * through here, a Voice agent's and a lost Call's alike (ticket #1387), and wakes the Turn that reviews
 * it, as a Bot's result does. On a thread the owner took over the entry waits for them and no Turn runs;
 * a blocked or opted-out caller gets no Turn, and no owner's wait, as their message would.
 */
export async function closeCall(
  services: Pick<FeatureContext, "db" | "clock" | "jobs">,
  tx: Transaction,
  now: Date,
  call: CallToEnd,
  {
    status,
    text,
  }: {
    status: "ended" | "ended_no_transcript";
    text: (requests: readonly RecordedRequest[]) => string;
  },
) {
  const { threadId } = call;
  // The caller's Customer before their thread, as for a message: a delete holds it, then looks for
  // their words on every thread, and the status below finds a Call that delete has taken.
  let caller = await callerOf(tx, call.userId, call.identityId, call.externalId);
  if (caller) {
    await tx
      .select({ id: representativeCustomer.id })
      .from(representativeCustomer)
      .where(eq(representativeCustomer.id, caller.customerId))
      .for("key share");
  }
  // The thread's lock first, as a delete and a merge take it before the rows under it.
  const thread = await tryLockThread(tx, call.userId, threadId);
  if (!thread) return false;
  // The Call's row last, as a request takes it too, and only now its number: a correction that
  // held the caller's row as this waited has rewritten it.
  const [held] = await tx
    .select({ externalId: representativeCall.externalId, requests: representativeCall.requests })
    .from(representativeCall)
    .where(and(eq(representativeCall.id, call.id), eq(representativeCall.status, "in_progress")))
    .for("update");
  if (!held) return false;
  const { externalId, requests } = held;
  if (call.identityId === null && externalId !== call.externalId) {
    caller = await callerOf(tx, call.userId, null, externalId);
  }
  const kept = thread.blockedAt !== null || (caller?.optedOutAt ?? null) !== null;
  const messageId = uuidv7();
  await tx
    .update(representativeCall)
    .set({ status, endedAt: now, messageId })
    .where(eq(representativeCall.id, call.id));
  const nowSql = sql`${now.toISOString()}::timestamp`;
  const wakes = thread.state === "representative" && !kept;
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
    text: text(requests).slice(0, maxThreadMessageLength),
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
  } else if (thread.state === "owner" && !kept) {
    await queueOwnerWait(services, tx, threadId, now);
  }
  return { blocked: thread.blockedAt !== null };
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
        identityId: representativeCall.identityId,
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
    await closeCall(context, tx, now, call, {
      status: "ended",
      text: () => transcriptText(transcript),
    });
  });
  return { ok: true };
}

export const callEndRoutes = [voiceHookRoute("end", callEndBody, endCall)];
