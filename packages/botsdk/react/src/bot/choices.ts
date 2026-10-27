import type { ChoiceInput } from "@botsdk/client/bot/choice";
import { useQueryClient } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useItemActions } from "./turn-list";

/**
 * The user's answers to the choices a Bot asked (spec #761): `answer` calls `bots.choose` for
 * Message `messageId`, then asks for the Conversation again, whose choice card holds the answered
 * state (and shows the Turn the answer woke). `acting` holds the Messages with a call in flight.
 */
export function useBotChoices(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const { acting, act } = useItemActions(async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.bots.get.queryKey({ input: { botId } }) });
  });
  return {
    acting,
    answer: async (messageId: string, answer: ChoiceInput) => {
      await act(messageId, () => orpc.bots.choose.call({ botId, messageId, answer }));
    },
  };
}
