import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useChatAdapter } from "../provider";

/**
 * The user's Bot pause and resume (spec #1007), then the Bot's thread, Tasks view and the Bot list
 * asked for again, so the badge, the banner and the composer follow. `acting` is true while one is
 * in flight.
 */
export function useBotPause(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const [acting, setActing] = useState(false);
  const input = { input: { botId } };
  const act = async (call: () => Promise<void>) => {
    setActing(true);
    try {
      await call();
    } finally {
      await Promise.all(
        [
          orpc.bots.get.queryKey(input),
          orpc.bots.tasks.queryKey(input),
          orpc.bots.list.queryKey(),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      setActing(false);
    }
  };
  return {
    acting,
    pause: () => act(() => orpc.bots.pause.call({ botId })),
    resume: () => act(() => orpc.bots.resume.call({ botId })),
  };
}
