import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";

/**
 * A Bot's Routines (#538), sorted by name, and the user's yes or no to a pending one. `working` is a
 * Turn running anywhere (`useBotTurn`): the Routines are asked for again while it runs and once it
 * ends, since it may have created one.
 */
export function useBotRoutines(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.bot.routine.list.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchInterval: working ? 2000 : false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey });
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) void refresh();
    wasWorking.current = working;
  });
  const act = (call: (input: { routineId: string }) => Promise<unknown>) => async (id: string) => {
    try {
      await call({ routineId: id });
    } finally {
      await refresh();
    }
  };
  return {
    routines: query.data ?? [],
    approve: act((input) => orpc.bot.routine.approve.call(input)),
    decline: act((input) => orpc.bot.routine.decline.call(input)),
  };
}
