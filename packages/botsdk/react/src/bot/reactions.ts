import { useQueryClient } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useItemActions } from "./turn-list";

/**
 * The user's emoji on the Bot's Messages (spec #761): `react` calls `bots.react` for Message
 * `messageId` (`null` takes theirs off), then asks for the Conversation again, whose Messages hold
 * the chip. It wakes no Turn. `acting` holds the Messages with a call in flight.
 */
export function useBotReactions(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const { acting, act } = useItemActions(async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.bots.get.queryKey({ input: { botId } }) });
  });
  return {
    acting,
    react: async (messageId: string, emoji: string | null) => {
      await act(messageId, () => orpc.bots.react.call({ botId, messageId, emoji }));
    },
  };
}
