import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import {
  draftRule,
  representative,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
} from "./db/schema";

/*
 * A Reply draft past its due time Pages the owner (ticket #1307). Each draft keeps one delayed job,
 * queued with it: when it runs, a draft the owner hasn't answered, on a thread the Representative
 * still holds and that is switched on, raises one Page. A thread the owner holds lists no draft, so there is nothing to
 * wait on, and one answered, replaced or gone since needs no Page.
 */

/** How long a Reply draft may wait for the owner before they are Paged. */
export const draftDueMs = 30 * 60_000;

export const draftDueJobName = "representative.draft-due";

const draftDuePayload = z.object({ heldId: z.uuid() });

/** What a Page for a draft past due says raised it. */
const draftDueCause = "reply_draft_due";

/** Queues the check for the draft `heldId`, in `tx`, for `draftDueMs` after `now`. A repeat is a no-op. */
export async function queueDraftDue(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  heldId: string,
  now: Date,
) {
  await jobs.enqueueIn(
    tx,
    { name: draftDueJobName, payload: draftDuePayload },
    { heldId },
    {
      idempotencyKey: `${draftDueJobName}:${heldId}`,
      runAfter: new Date(now.getTime() + draftDueMs),
    },
  );
}

export const draftDueJob = defineJob<z.infer<typeof draftDuePayload>, FeatureContext<"pages">>({
  name: draftDueJobName,
  payload: draftDuePayload,
  run: async ({ heldId }, job) => {
    await job.step("representative_draft_due", async (tx) => {
      const held = representativeHeldMessage;
      const [draft] = await tx
        .select({
          userId: representative.userId,
          representativeId: representative.id,
          name: representative.name,
        })
        .from(held)
        .innerJoin(
          representativeOutboundDecision,
          eq(representativeOutboundDecision.id, held.decisionId),
        )
        .innerJoin(representativeThread, eq(representativeThread.id, held.threadId))
        .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
        .where(
          and(
            eq(held.id, heldId),
            isNull(held.resolution),
            eq(representativeOutboundDecision.rule, draftRule),
            eq(representativeThread.state, "representative"),
            eq(representative.enabled, true),
          ),
        );
      if (!draft) return;
      await job.pages.send(tx, {
        userId: draft.userId,
        cause: draftDueCause,
        urgency: "routine",
        title: "A reply is waiting for you",
        text: `A draft reply from ${draft.name} has waited more than ${draftDueMs / 60_000} minutes for you to approve, edit or reject it.`,
        path: `/representatives/${draft.representativeId}`,
      });
    });
  },
});
