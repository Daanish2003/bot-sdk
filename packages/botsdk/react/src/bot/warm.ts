import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { useChatAdapter } from "../provider";

/** The least time between two asks to warm one Bot's cache from one tab. */
export const warmIntervalMs = 60_000;

/** When this tab last asked to warm each Bot. */
const askedAt = new Map<string, number>();

/**
 * Asks the server to warm Bot `botId`'s cache (slide 32), once now (the Conversation just opened)
 * and again whenever the returned function is called, which the composer does on the first keystroke
 * of a draft. Each Bot is asked for at most once a minute per tab; the server decides whether the
 * cache needs it. A warm that was made adds its line to the thread. A failed ask is ignored, and may be
 * made again at once: the next Turn simply finds the cache cold.
 */
export function useCacheWarming(botId: string): () => void {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const warm = useCallback(() => {
    const now = Date.now();
    const last = askedAt.get(botId);
    if (last !== undefined && now - last < warmIntervalMs) return;
    askedAt.set(botId, now);
    orpc.bots.warm
      .call({ botId })
      .then((result) => {
        if (!result.warmed) return;
        return queryClient.invalidateQueries({
          queryKey: orpc.bots.get.queryOptions({ input: { botId } }).queryKey,
        });
      })
      .catch(() => {
        // Nothing was warmed, so the next ask may try again.
        askedAt.delete(botId);
      });
  }, [botId, orpc, queryClient]);
  useEffect(warm, [warm]);
  return warm;
}
