import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";
import type { DemonstrationAction, DemonstrationStep } from "../../shared/demonstration";
import { useItemActions } from "./turn-list";

/**
 * The user's Pause, Resume, Done and Cancel on a Bot's Demonstrations (spec #713): `act` calls
 * `bot.demonstration.<action>`, then asks for the Conversation again, whose Show me card holds the
 * new state. `acting` holds the Demonstrations with one in flight.
 */
export function useDemonstrationActions(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const { acting, act } = useItemActions(async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.bot.get.queryKey({ input: { botId } }) });
  });
  return {
    acting,
    act: async (demonstrationId: string, action: DemonstrationAction) => {
      await act(demonstrationId, () => orpc.bot.demonstration[action].call({ demonstrationId }));
    },
  };
}

/**
 * The live view of a Demonstration's Screen: a fresh link from `bot.demonstration.view` on mount,
 * never stored. The Screen is the user's to drive the whole time, so there is no control to take.
 * `failed` once the link couldn't be had.
 */
export function useDemonstrationView(demonstrationId: string) {
  const { orpc } = useChatAdapter();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    orpc.bot.demonstration.view
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
 * The steps Demonstration `demonstrationId` captured (#719), from `bot.demonstration.steps`, read
 * again whenever its card counts a new one (`count`) or changes state.
 */
export function useDemonstrationSteps(
  demonstrationId: string,
  count: number,
  state: string,
): DemonstrationStep[] {
  const { orpc } = useChatAdapter();
  const options = orpc.bot.demonstration.steps.queryOptions({ input: { demonstrationId } });
  const query = useQuery({
    ...options,
    queryKey: [...options.queryKey, count, state],
    placeholderData: keepPreviousData,
  });
  return query.data?.steps ?? [];
}
