import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useItemActions } from "./turn-list";

/**
 * The user's Secrets (spec #691), by name with their saved dates, never a value; they are shared by
 * all the user's Bots. `save` sends a value to the server for Secret `name` and wakes Bot `botId`;
 * `remove` deletes one. `acting` holds the names with a call in flight.
 */
export function useBotSecrets(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.secrets.list.queryOptions();
  const query = useQuery(options);
  const { acting, act } = useItemActions(() =>
    queryClient.invalidateQueries({ queryKey: options.queryKey }),
  );
  return {
    secrets: query.data ?? [],
    acting,
    save: async (name: string, value: string) => {
      await act(name, async () => {
        await orpc.secrets.save.call({ botId, name, value });
        // The save wakes the Bot: its Turn shows once the Conversation is read again.
        await queryClient.invalidateQueries({
          queryKey: orpc.bots.get.queryKey({ input: { botId } }),
        });
      });
    },
    remove: async (name: string) => {
      await act(name, () => orpc.secrets.delete.call({ name }));
    },
  };
}
