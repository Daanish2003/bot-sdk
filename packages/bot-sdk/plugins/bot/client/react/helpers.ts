import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { isLiveHelper } from "../../shared/helper";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/** The `acting` key of Stop all. */
export const allHelpers = "all";

/**
 * A Bot's Helpers (#590), oldest first. They are asked for again every 2 seconds while any is live
 * (they work after the Turn that started them ended), and while a Turn runs anywhere
 * (`useBotTurn`), since it may start one. `working` is that Turn. `stop` stops one Helper, or all
 * of them with no id (#591); `acting` holds the Helpers (or `allHelpers`) with a stop in flight.
 */
export function useBotHelpers(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.bot.helper.list.queryOptions({ input: { botId } });
  const query = useQuery({
    ...options,
    refetchInterval: (current) =>
      working || current.state.data?.some((helper) => isLiveHelper(helper.status)) ? 2000 : false,
  });
  const { acting, act } = useItemActions(useRefreshAfterTurns(options.queryKey, working));
  return {
    helpers: query.data ?? [],
    acting,
    stop: async (helperId?: string) => {
      await act(helperId ?? allHelpers, () => orpc.bot.helper.stop.call({ botId, helperId }));
    },
  };
}
