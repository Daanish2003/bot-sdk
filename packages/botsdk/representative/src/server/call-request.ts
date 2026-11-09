import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { noNul } from "../shared/contract";
import { representativeCall } from "./db/schema";
import { pageEmergency } from "./emergency-script";
import { callIdField, voiceHookRoute, type VoiceHookAccount } from "./voice-hook";

/*
 * Record request (ticket #1383, ADR 0036): the Voice agent's one tool, run during a Call. It stores what
 * the caller wants against the Call and returns at once; nothing else acts during a Call. The emergency
 * flag Pages the owner, as a Page only: nothing is sent to the caller or stored on the thread.
 */

const callRequestBody = z.object({
  callId: callIdField,
  request: z.string().min(1).max(2000).refine(noNul),
  callback: z.string().max(500).refine(noNul).optional(),
  emergency: z.boolean(),
});

async function recordRequest(
  context: FeatureContext<"pages">,
  account: VoiceHookAccount,
  { callId, request, callback, emergency }: z.infer<typeof callRequestBody>,
) {
  const recorded = await context.db.transaction(async (tx) => {
    const [call] = await tx
      .update(representativeCall)
      .set({
        // Appended in the database, so two requests at once both stay.
        requests: sql`${representativeCall.requests} || ${JSON.stringify([
          { request, ...(callback ? { callback } : {}), emergency },
        ])}::jsonb`,
      })
      .where(
        and(
          eq(representativeCall.channelAccountId, account.id),
          eq(representativeCall.callId, callId),
        ),
      )
      .returning({ threadId: representativeCall.threadId });
    if (!call) return false;
    if (emergency) await pageEmergency(context, tx, { threadId: call.threadId });
    return true;
  });
  return { recorded };
}

export const callRequestRoutes = [voiceHookRoute("request", callRequestBody, recordRequest)];
