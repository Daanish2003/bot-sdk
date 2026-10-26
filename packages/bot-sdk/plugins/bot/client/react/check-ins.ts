import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/**
 * A Bot's Check-ins (#540), soonest first, and the user's cancel of a pending one. `working` is a
 * Turn running anywhere (`useBotTurn`): the Check-ins are asked for again while it runs and once it
 * ends, since it may have set or cancelled one. `acting` holds the Check-ins with a cancel in flight.
 */
export function useBotCheckIns(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.checkIns.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const { acting, act } = useItemActions(useRefreshAfterTurns(options.queryKey, working));
  return {
    checkIns: query.data ?? [],
    acting,
    cancel: async (checkInId: string) => {
      await act(checkInId, () => orpc.checkIns.cancel.call({ checkInId }));
    },
  };
}
