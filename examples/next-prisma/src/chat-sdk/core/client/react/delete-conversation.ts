import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { I18n } from "../../shared/i18n";
import { serverErrorText } from "../rpc-error";
import { invalidateConversationList } from "./conversation-list";
import { useChatAdapter, useChatLocation } from "./provider";

/** The `window.confirm` text for deleting a Conversation: its title, and a note when it has a Shared link. */
export function deleteConfirmText(
  { t }: I18n,
  conversation: { title: string | null; shared: boolean },
) {
  return t("shell.deleteConfirm", {
    title: conversation.title ?? t("shell.untitled"),
    shared: conversation.shared,
  });
}

/**
 * Deletes a Conversation after the user confirms (mentioning its Shared link), leaving it first
 * when it's open. Used by the Conversation panel and the palette.
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const { orpc, navigate, i18n } = useChatAdapter();
  const { conversationId: openId } = useChatLocation();
  const remove = useMutation(
    orpc.conversation.delete.mutationOptions({
      onSuccess: async (_, { id }) => {
        if (openId === id) await navigate({ to: "new" });
        queryClient.removeQueries({ queryKey: orpc.conversation.get.queryKey({ input: { id } }) });
        await invalidateConversationList(queryClient, orpc);
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const confirmDelete = (conversation: { id: string; title: string | null; shared: boolean }) => {
    if (window.confirm(deleteConfirmText(i18n, conversation))) {
      remove.mutate({ id: conversation.id });
    }
  };

  return { confirmDelete, isPending: remove.isPending };
}
