import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useRefreshAfterTurns } from "./turn-list";

/**
 * A Bot's Auto-reviews (spec #691), oldest first, for each Turn's passes line. `working` is a Turn
 * running anywhere (`useBotTurn`): they are asked for again while it runs and once it ends, since
 * its shell calls are reviewed.
 */
export function useBotReviews(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.bot.review.list.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchInterval: working ? 2000 : false });
  useRefreshAfterTurns(options.queryKey, working);
  return query.data ?? [];
}
