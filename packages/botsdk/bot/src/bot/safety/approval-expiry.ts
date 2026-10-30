import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { botReview } from "../../storage";
import { defineCoreJob } from "../../runner/internal";
import { hintChanged, recordBotChange, reviewOwnerOf } from "../conversation";
import { lockConversation } from "../triggers";

/** The runner job that expires one pending Approval (ADR 0030). */
export const approvalExpiryJobName = "bot.approval_expiry";

/** The key of an Approval's expiry job. */
export const approvalExpiryKey = (reviewId: string) => `approval_expiry:${reviewId}`;

/**
 * One pending Approval's expiry (ADR 0030), a delayed job scheduled when the row goes pending. A
 * row still `pending` becomes `expired`, with its `review` change, and wakes nobody: no Trigger is
 * handed to the Router. A row answered meanwhile is left as it is.
 */
export const approvalExpiryJob = defineCoreJob({
  name: approvalExpiryJobName,
  payload: z.object({ reviewId: z.uuid() }),
  run: async ({ reviewId }, ctx) => {
    const deps = ctx.deps;
    const expired = await ctx.step("expire", async (tx) => {
      const owner = await reviewOwnerOf(tx, reviewId);
      if (!owner) return null;
      await lockConversation(tx, owner.conversationId);
      const now = deps.clock();
      const rows = await tx
        .update(botReview)
        .set({ state: "expired", decidedAt: now })
        .where(and(eq(botReview.id, reviewId), eq(botReview.state, "pending")))
        .returning({ id: botReview.id });
      if (rows.length === 0) return null;
      await recordBotChange(tx, owner, "review", reviewId, now);
      return owner.conversationId;
    });
    if (expired) await hintChanged(deps, expired);
  },
});
