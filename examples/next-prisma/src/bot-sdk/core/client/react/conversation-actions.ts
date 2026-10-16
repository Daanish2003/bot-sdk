import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { I18n } from "../../shared/i18n";
import { serverErrorText } from "../rpc-error";
import { invalidateConversationList } from "./conversation-list";
import { useChatAdapter } from "./provider";

/** The `window.prompt` text for renaming a Conversation. */
export function renamePromptText({ t }: I18n) {
  return t("shell.renameConversation");
}

/** Pins and unpins a Conversation from its row menu; both refresh the Conversation panel's lists. */
export function usePinConversation() {
  const queryClient = useQueryClient();
  const { orpc, i18n } = useChatAdapter();
  // Pinning an archived Conversation unarchives it, so its page's `archivedAt` is refetched too.
  const onSuccess = async (_: unknown, { id }: { id: string }) => {
    await invalidateConversationList(queryClient, orpc);
    await queryClient.invalidateQueries({
      queryKey: orpc.conversation.get.queryKey({ input: { id } }),
    });
  };
  const onError = (error: Error) => toast.error(serverErrorText(i18n, error));
  const pin = useMutation(orpc.conversation.pin.mutationOptions({ onSuccess, onError }));
  const unpin = useMutation(orpc.conversation.unpin.mutationOptions({ onSuccess, onError }));

  return {
    /** Unpins a pinned Conversation and pins an unpinned one. */
    toggle: (conversation: { id: string; pinnedAt: Date | null }) => {
      if (conversation.pinnedAt) unpin.mutate({ id: conversation.id });
      else pin.mutate({ id: conversation.id });
    },
    isPending: pin.isPending || unpin.isPending,
  };
}

/**
 * Archives and unarchives a Conversation: from the row menu, ⌘K, and an archived Conversation's
 * notice. Both refresh the Conversation panel's lists and the Conversation's own page.
 */
export function useArchiveConversation() {
  const queryClient = useQueryClient();
  const { orpc, i18n } = useChatAdapter();
  const onSuccess = async (_: unknown, { id }: { id: string }) => {
    await invalidateConversationList(queryClient, orpc);
    await queryClient.invalidateQueries({
      queryKey: orpc.conversation.get.queryKey({ input: { id } }),
    });
  };
  const onError = (error: Error) => toast.error(serverErrorText(i18n, error));
  const archive = useMutation(orpc.conversation.archive.mutationOptions({ onSuccess, onError }));
  const unarchive = useMutation(
    orpc.conversation.unarchive.mutationOptions({ onSuccess, onError }),
  );

  return {
    archive: (id: string) => archive.mutate({ id }),
    unarchive: (id: string) => unarchive.mutate({ id }),
    isPending: archive.isPending || unarchive.isPending,
  };
}

/**
 * Renames a Conversation after the user types a new title (an empty one is ignored). Used by the
 * Conversation panel's row menu.
 */
export function useRenameConversation() {
  const queryClient = useQueryClient();
  const { orpc, i18n } = useChatAdapter();
  const rename = useMutation(
    orpc.conversation.rename.mutationOptions({
      onSuccess: async (_, { id }) => {
        await queryClient.invalidateQueries({
          queryKey: orpc.conversation.get.queryKey({ input: { id } }),
        });
        await invalidateConversationList(queryClient, orpc);
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const promptRename = (conversation: { id: string; title: string | null }) => {
    const next = window.prompt(renamePromptText(i18n), conversation.title ?? "")?.trim();
    if (next && next !== conversation.title) rename.mutate({ id: conversation.id, title: next });
  };

  return { promptRename, isPending: rename.isPending };
}
