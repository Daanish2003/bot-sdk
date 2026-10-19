import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";

/**
 * A Bot's Check-ins (#540), soonest first, and the user's cancel of a pending one. `working` is a
 * Turn running anywhere (`useBotTurn`): the Check-ins are asked for again while it runs and once it
 * ends, since it may have set or cancelled one.
 */
export function useBotCheckIns(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.bot.checkIn.list.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchInterval: working ? 2000 : false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey });
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) void refresh();
    wasWorking.current = working;
  });
  return {
    checkIns: query.data ?? [],
    cancel: async (checkInId: string) => {
      try {
        await orpc.bot.checkIn.cancel.call({ checkInId });
      } finally {
        await refresh();
      }
    },
  };
}
