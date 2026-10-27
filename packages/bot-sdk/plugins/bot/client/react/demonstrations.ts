import type { DemonstrationAction, DemonstrationStep } from "@botsdk/client/bot/demonstration";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useItemActions } from "./turn-list";

/**
 * The user's Pause, Resume, Done and Cancel on a Bot's Demonstrations (spec #713): `act` calls
 * `demonstrations.<action>`, then asks for the Conversation again, whose Show me card holds the
 * new state. `acting` holds the Demonstrations with one in flight.
 */
export function useDemonstrationActions(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const { acting, act } = useItemActions(async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.bots.get.queryKey({ input: { botId } }) });
  });
  return {
    acting,
    act: async (demonstrationId: string, action: DemonstrationAction) => {
      await act(demonstrationId, () => orpc.demonstrations[action].call({ demonstrationId }));
    },
  };
}

/**
 * The live view of a Demonstration's Screen: a fresh link from `demonstrations.view` on mount,
 * never stored. The Screen is the user's to drive the whole time, so there is no control to take.
 * `failed` once the link couldn't be had.
 */
export function useDemonstrationView(demonstrationId: string) {
  const { orpc } = useChatAdapter();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    orpc.demonstrations.view
      .call({ demonstrationId })
      .then((view) => current && setUrl(view.url))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [orpc, demonstrationId]);
  return { url, failed };
}

/**
 * The steps Demonstration `demonstrationId` captured (#719), from `demonstrations.steps`, read
 * again whenever its card counts a new one (`count`) or changes state.
 */
export function useDemonstrationSteps(
  demonstrationId: string,
  count: number,
  state: string,
): DemonstrationStep[] {
  const { orpc } = useChatAdapter();
  const options = orpc.demonstrations.steps.queryOptions({ input: { demonstrationId } });
  const query = useQuery({
    ...options,
    queryKey: [...options.queryKey, count, state],
    placeholderData: keepPreviousData,
  });
  return query.data?.steps ?? [];
}
