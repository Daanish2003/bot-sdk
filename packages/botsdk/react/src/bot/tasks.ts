import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useChatAdapter } from "../provider";

/**
 * A Bot's Tasks view (spec #1007): the one read behind the "Tasks N" popover. It is asked for again
 * when the change log says a Turn, Helper, Routine or Check-in changed (`useBotSync`), and when a
 * Turn starts or ends on this page (`working`, `useBotTurn`).
 */
export function useBotTasks(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.bots.tasks.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const was = useRef(working);
  useEffect(() => {
    if (was.current !== working) void queryClient.invalidateQueries({ queryKey: options.queryKey });
    was.current = working;
  });
  return { tasks: query.data };
}

/** Asks for Bot `botId`'s Tasks view again, once an action of the user's has changed its lists. */
export function useRefreshTasks(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.bots.tasks.queryKey({ input: { botId } }) });
}
