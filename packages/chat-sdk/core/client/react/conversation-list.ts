import type { QueryClient } from "@tanstack/react-query";

import type { ChatOrpc } from "./provider";

/**
 * Refetches the Conversation panel's lists, the dated one and Pinned: after a send, a run's end, a
 * new Conversation, a rename, a pin or a delete.
 */
export function invalidateConversationList(queryClient: QueryClient, orpc: ChatOrpc) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.conversation.list.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.conversation.pinned.key() }),
  ]);
}
