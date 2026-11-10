import { eq } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { closeCall } from "./call-end";
import {
  representative,
  representativeCall,
  representativeThread,
  type RecordedRequest,
} from "./db/schema";

/*
 * A Call with no end is closed (ticket #1387, ADR 0036). A dropped Call can't be lost: each Call keeps
 * one delayed job, queued when it starts. When it runs, a Call still going is closed as "ended, no
 * transcript" through the same path as a Voice agent's end, so its `call` entry is added, carrying any
 * requests recorded, and the owner is Paged. A Call that ended is left alone, and an end arriving later
 * finds it closed and adds nothing.
 */

/** How long a Call may go with no end before it is closed. */
export const callEndDueMs = 15 * 60_000;

export const callLostJobName = "representative.call-lost";

const callLostPayload = z.object({ callId: z.uuid() });

/** What a Page for a Call with no end says raised it. */
const callLostCause = "call_not_ended";

/** Queues the check for the Call row `callId`, in `tx`, for `callEndDueMs` after `now`. A repeat is a no-op. */
export async function queueCallLost(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  callId: string,
  now: Date,
) {
  await jobs.enqueueIn(
    tx,
    { name: callLostJobName, payload: callLostPayload },
    { callId },
    {
      idempotencyKey: `${callLostJobName}:${callId}`,
      runAfter: new Date(now.getTime() + callEndDueMs),
    },
  );
}

/** What the entry says of a Call that ended without a transcript: the requests it recorded, a line each. */
function lostText(requests: readonly RecordedRequest[]) {
  const lines = ["The call ended without a transcript."];
  for (const { request, callback, emergency } of requests) {
    lines.push(
      `Request${emergency ? " (emergency)" : ""}: ${request}${callback ? ` (callback: ${callback})` : ""}`,
    );
  }
  // One line per thing, so the owner's view can read the lines back.
  return lines.map((line) => line.replaceAll(/\s+/g, " ").trim()).join("\n");
}

export const callLostJob = defineJob<z.infer<typeof callLostPayload>, FeatureContext<"pages">>({
  name: callLostJobName,
  payload: callLostPayload,
  run: async ({ callId }, job) => {
    const now = await job.now();
    await job.step("representative_call_lost", async (tx) => {
      const [call] = await tx
        .select({
          id: representativeCall.id,
          threadId: representativeCall.threadId,
          externalId: representativeCall.externalId,
          identityId: representativeCall.identityId,
          userId: representative.userId,
          representativeId: representative.id,
          name: representative.name,
        })
        .from(representativeCall)
        .innerJoin(representativeThread, eq(representativeThread.id, representativeCall.threadId))
        .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
        .where(eq(representativeCall.id, callId));
      if (!call) return;
      const closed = await closeCall(job, tx, now, call, {
        status: "ended_no_transcript",
        text: lostText,
      });
      // A blocked caller Pages no one, as their emergency wouldn't.
      if (!closed || closed.blocked) return;
      await job.pages.send(tx, {
        userId: call.userId,
        cause: callLostCause,
        urgency: "routine",
        title: "A call ended with no transcript",
        text: `A call to ${call.name} dropped and sent no transcript. What the caller asked for, if anything, is on the thread.`,
        path: `/representatives/${call.representativeId}`,
      });
    });
  },
});
