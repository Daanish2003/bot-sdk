import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useRefreshTasks } from "./tasks";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/**
 * The Assignments handed to a Bot (spec #1166), oldest first, each with its log, and the user's
 * cancel of one that hasn't ended. `working` is a Turn running anywhere (`useBotTurn`): they are
 * asked for again while it runs and once it ends. `acting` holds the Assignments with a cancel in
 * flight.
 */
export function useBotAssignments(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.assignments.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const refreshList = useRefreshAfterTurns(options.queryKey, working);
  const refreshTasks = useRefreshTasks(botId);
  const { acting, act } = useItemActions(async () => {
    await Promise.all([refreshList(), refreshTasks()]);
  });
  return {
    assignments: query.data ?? [],
    acting,
    cancel: async (assignmentId: string) => {
      await act(assignmentId, () => orpc.assignments.cancel.call({ botId, assignmentId }));
    },
  };
}
