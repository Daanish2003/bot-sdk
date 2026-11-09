import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { maxThreadMessageLength, noNul } from "../shared/contract";
import { transcriptText } from "./call-transcript";
import { smsChannel } from "./customer-proof";
import {
  representative,
  representativeCall,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { tryLockThread } from "./takeover";
import { callIdField, voiceHookRoute, type VoiceHookAccount } from "./voice-hook";

/*
 * Call end (ticket #1384, ADR 0036): a Voice agent posts the transcript, which joins the Customer's
 * thread as one `call` entry. It isn't a Customer's message: what a Voice agent reports proves nothing
 * and goes through no check for a code, since a code read aloud must not pass as proof, and it wakes no
 * Turn here. The Call's status makes a repeat harmless.
 */

const callEndBody = z.object({
  callId: callIdField,
  transcript: z
    .array(
      z.object({
        role: z.enum(["caller", "agent"]),
        text: z.string().refine(noNul),
      }),
    )
    .refine(
      (lines) => lines.reduce((sum, { text }) => sum + text.length, 0) <= maxThreadMessageLength,
    ),
});

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
    const [updated] = await tx
      .update(representativeThread)
      .set({
        messageCount: sql`${representativeThread.messageCount} + 1`,
        ...(thread.state !== "closed" && {
          updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
        }),
      })
      .where(eq(representativeThread.id, call.threadId))
      .returning({ position: representativeThread.messageCount });
    await tx.insert(representativeThreadMessage).values({
      id: messageId,
      threadId: call.threadId,
      position: updated!.position,
      author: "call",
      text: transcriptText(transcript),
      // Every caller is unverified: the number is only what the vendor reports.
      verified: false,
      channel: smsChannel,
      externalId: call.externalId,
      createdAt: now,
    });
  });
  return { ok: true };
}

export const callEndRoutes = [voiceHookRoute("end", callEndBody, endCall)];
