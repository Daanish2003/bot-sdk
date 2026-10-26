import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/**
 * A Bot's Auto-reviews (spec #691), oldest first, for each Turn's passes line and its Approval
 * cards, and the user's answers to a waiting one. `working` is a Turn running anywhere
 * (`useBotTurn`): they are asked for again while it runs and once it ends, since its shell calls
 * are reviewed. `acting` holds the requests with an answer in flight.
 */
export function useBotReviews(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.reviews.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const { acting, act } = useItemActions(useRefreshAfterTurns(options.queryKey, working));
  return {
    reviews: query.data ?? [],
    acting,
    allow: async (reviewId: string) => {
      await act(reviewId, () => orpc.reviews.allow.call({ reviewId }));
    },
    deny: async (reviewId: string) => {
      await act(reviewId, () => orpc.reviews.deny.call({ reviewId }));
    },
  };
}
