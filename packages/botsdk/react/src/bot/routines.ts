import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useChatAdapter } from "../provider";
import { useRefreshTasks } from "./tasks";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/**
 * A Bot's Routines (#538), sorted by name, the user's yes or no to a pending one, and their pause,
 * resume, delete and webhook URL rotate. `working` is a
 * Turn running anywhere (`useBotTurn`): the Routines are asked for again while it runs and once it
 * ends, since it may have created or changed one. `webhookTokens` holds, by Routine, the webhook
 * token that approving or rotating gave on this page: the server keeps only its hash (ADR 0021).
 * `acting` holds the Routines with an action in flight, one at a time each.
 */
export function useBotRoutines(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const options = orpc.routines.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const [webhookTokens, setWebhookTokens] = useState<Record<string, string>>({});
  const refreshList = useRefreshAfterTurns(options.queryKey, working);
  const refreshTasks = useRefreshTasks(botId);
  const { acting, act } = useItemActions(async () => {
    await Promise.all([refreshList(), refreshTasks()]);
  });
  const action =
    (call: (input: { routineId: string }) => Promise<unknown>) => async (id: string) => {
      const result = await act(id, () => call({ routineId: id }));
      // Approving a webhook Routine and rotating its URL give its token, this once.
      const token = (result as { webhookToken?: string } | undefined)?.webhookToken;
      if (token) setWebhookTokens((tokens) => ({ ...tokens, [id]: token }));
    };
  return {
    routines: query.data ?? [],
    webhookTokens,
    acting,
    approve: action((input) => orpc.routines.approve.call(input)),
    decline: action((input) => orpc.routines.decline.call(input)),
    pause: action((input) => orpc.routines.pause.call(input)),
    resume: action((input) => orpc.routines.resume.call(input)),
    remove: action((input) => orpc.routines.delete.call(input)),
    rotate: action((input) => orpc.routines.rotate.call(input)),
  };
}
