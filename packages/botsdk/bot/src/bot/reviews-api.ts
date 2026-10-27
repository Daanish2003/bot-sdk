import { reviewListInput, reviewDecisionInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { requireOwnedBot } from "./owned-bot";
import { decideReview, listReviews } from "./safety";

/*
 * The `reviews` namespace's domain methods (spec #873): the user's side of the Auto-reviews of
 * their Bots' tool calls (spec #691), taking the user's id as `bots` does.
 */

/** The `reviews` namespace over the core context. */
export function reviewsApi(sdk: BotSdkContext) {
  return {
    /**
     * One of the user's Bots' newest reviews and its waiting ones, oldest first, each with its
     * Turn or Helper: what the passes line under a Turn lists. Another user's Bot is not found.
     */
    list: async ({ userId, ...rest }: WithUser<typeof reviewListInput>) => {
      const { botId } = parseInput(reviewListInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      return listReviews(sdk.db, botId);
    },

    /**
     * Allows a blocked call while its Approval waits (ADR 0024): the call runs. A late or second
     * answer changes nothing and comes back `decided: false`, with how the request stands.
     * Another user's is not found.
     */
    allow: async ({ userId, ...rest }: WithUser<typeof reviewDecisionInput>) =>
      decideReview(sdk, userId, parseInput(reviewDecisionInput, rest).reviewId, "allowed"),

    /** Denies a blocked call while its Approval waits, as `allow` allows it: the call doesn't run. */
    deny: async ({ userId, ...rest }: WithUser<typeof reviewDecisionInput>) =>
      decideReview(sdk, userId, parseInput(reviewDecisionInput, rest).reviewId, "denied"),
  };
}

/** The `reviews` namespace's domain methods. */
export type ReviewsApi = ReturnType<typeof reviewsApi>;
