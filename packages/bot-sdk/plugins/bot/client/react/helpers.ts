import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { isLiveHelper } from "../../shared/helper";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/** The `acting` key of Stop all. */
export const allHelpers = "all";

/**
 * A Bot's Helpers (#590), oldest first. They are asked for again every 2 seconds while any is live
 * (they work after the Turn that started them ended), and while a Turn runs anywhere
 * (`useBotTurn`), since it may start one. `working` is that Turn. `stop` stops one Helper, or all
 * of them with no id (#591), and `done` is the user's Done on a waiting one (#596); `acting` holds
 * the Helpers (or `allHelpers`) with one in flight. A Helper's hand-off Message is written by its
 * job, not a Turn, so the Conversation is asked for again whenever a Helper's status changes, and
 * after each action, which may flip a Computer card.
 */
export function useBotHelpers(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.bot.helper.list.queryOptions({ input: { botId } });
  const query = useQuery({
    ...options,
    refetchInterval: (current) =>
      working || current.state.data?.some((helper) => isLiveHelper(helper.status)) ? 2000 : false,
  });
  const refreshHelpers = useRefreshAfterTurns(options.queryKey, working);
  const refreshConversation = () =>
    queryClient.invalidateQueries({ queryKey: orpc.bot.get.queryKey({ input: { botId } }) });
  const { acting, act } = useItemActions(async () => {
    await Promise.all([refreshHelpers(), refreshConversation()]);
  });

  const statuses = query.data?.map((helper) => `${helper.id}:${helper.status}`).join();
  // The first list loaded is no change.
  const seen = useRef(statuses);
  useEffect(() => {
    if (seen.current === statuses) return;
    const loaded = seen.current !== undefined;
    seen.current = statuses;
    if (loaded) void refreshConversation();
  });

  return {
    helpers: query.data ?? [],
    acting,
    stop: async (helperId?: string) => {
      await act(helperId ?? allHelpers, () => orpc.bot.helper.stop.call({ botId, helperId }));
    },
    done: async (helperId: string) => {
      await act(helperId, () => orpc.bot.helper.done.call({ helperId }));
    },
  };
}
