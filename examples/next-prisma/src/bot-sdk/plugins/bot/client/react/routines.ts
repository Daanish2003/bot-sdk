import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";

/**
 * A Bot's Routines (#538), sorted by name, the user's yes or no to a pending one, and their pause,
 * resume, delete and webhook URL rotate. `working` is a
 * Turn running anywhere (`useBotTurn`): the Routines are asked for again while it runs and once it
 * ends, since it may have created or changed one. `webhookTokens` holds, by Routine, the webhook
 * token that approving or rotating gave on this page: the server keeps only its hash (ADR 0021).
 */
export function useBotRoutines(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.bot.routine.list.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchInterval: working ? 2000 : false });
  const [webhookTokens, setWebhookTokens] = useState<Record<string, string>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey });
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) void refresh();
    wasWorking.current = working;
  });
  const act = (call: (input: { routineId: string }) => Promise<unknown>) => async (id: string) => {
    try {
      const result = await call({ routineId: id });
      // Approving a webhook Routine and rotating its URL give its token, this once.
      const token = (result as { webhookToken?: string } | undefined)?.webhookToken;
      if (token) setWebhookTokens((tokens) => ({ ...tokens, [id]: token }));
    } finally {
      await refresh();
    }
  };
  return {
    routines: query.data ?? [],
    webhookTokens,
    approve: act((input) => orpc.bot.routine.approve.call(input)),
    decline: act((input) => orpc.bot.routine.decline.call(input)),
    pause: act((input) => orpc.bot.routine.pause.call(input)),
    resume: act((input) => orpc.bot.routine.resume.call(input)),
    remove: act((input) => orpc.bot.routine.delete.call(input)),
    rotate: act((input) => orpc.bot.routine.rotate.call(input)),
  };
}
