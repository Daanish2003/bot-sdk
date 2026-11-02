import { useQuery } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useRefreshAfterTurns } from "./turn-list";

/**
 * The Assignments handed to a Bot (spec #1166), oldest first, read-only. `working` is a Turn running
 * anywhere (`useBotTurn`): they are asked for again while it runs and once it ends.
 */
export function useBotAssignments(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.assignments.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  useRefreshAfterTurns(options.queryKey, working);
  return query.data ?? [];
}
