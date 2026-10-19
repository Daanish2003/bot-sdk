import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { isLiveHelper } from "../../shared/helper";
import { useRefreshAfterTurns } from "./turn-list";

/**
 * A Bot's Helpers (#590), oldest first. They are asked for again every 2 seconds while any is live
 * (they work after the Turn that started them ended), and while a Turn runs anywhere
 * (`useBotTurn`), since it may start one. `working` is that Turn.
 */
export function useBotHelpers(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.bot.helper.list.queryOptions({ input: { botId } });
  const query = useQuery({
    ...options,
    refetchInterval: (current) =>
      working || current.state.data?.some((helper) => isLiveHelper(helper.status)) ? 2000 : false,
  });
  useRefreshAfterTurns(options.queryKey, working);
  return { helpers: query.data ?? [] };
}
