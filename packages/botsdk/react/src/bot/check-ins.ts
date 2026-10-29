import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useRefreshTasks } from "./tasks";
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
  const refreshList = useRefreshAfterTurns(options.queryKey, working);
  const refreshTasks = useRefreshTasks(botId);
  const { acting, act } = useItemActions(async () => {
    await Promise.all([refreshList(), refreshTasks()]);
  });
  return {
    checkIns: query.data ?? [],
    acting,
    cancel: async (checkInId: string) => {
      await act(checkInId, () => orpc.checkIns.cancel.call({ checkInId }));
    },
    edit: async (input: { checkInId: string; at?: Date; note?: string }) => {
      await act(input.checkInId, () => orpc.checkIns.edit.call(input));
    },
  };
}
