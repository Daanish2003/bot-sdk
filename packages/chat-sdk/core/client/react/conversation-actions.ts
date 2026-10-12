import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { invalidateConversationList } from "./conversation-list";
import { useChatAdapter } from "./provider";

/** Pins and unpins a Conversation from its row menu; both refresh the Conversation panel's lists. */
export function usePinConversation() {
  const queryClient = useQueryClient();
  const { orpc } = useChatAdapter();
  // Pinning an archived Conversation unarchives it, so its page's `archivedAt` is refetched too.
  const onSuccess = async (_: unknown, { id }: { id: string }) => {
    await invalidateConversationList(queryClient, orpc);
    await queryClient.invalidateQueries({
      queryKey: orpc.conversation.get.queryKey({ input: { id } }),
    });
  };
  const onError = (error: Error) => toast.error(error.message);
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
  const { orpc } = useChatAdapter();
  const onSuccess = async (_: unknown, { id }: { id: string }) => {
    await invalidateConversationList(queryClient, orpc);
    await queryClient.invalidateQueries({
      queryKey: orpc.conversation.get.queryKey({ input: { id } }),
    });
  };
  const onError = (error: Error) => toast.error(error.message);
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
 * Moves a Conversation into a Project, or out of its Project with `null`, from its row menu. Refreshes
 * the Conversation panel's lists (the main one, Pinned and each Project's) and the Projects list.
 */
export function useMoveConversation() {
  const queryClient = useQueryClient();
  const { orpc } = useChatAdapter();
  const move = useMutation(
    orpc.conversation.move.mutationOptions({
      onSuccess: async () => {
        await invalidateConversationList(queryClient, orpc);
        await queryClient.invalidateQueries({ queryKey: orpc.project.list.key() });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return {
    moveTo: (conversation: { id: string }, projectId: string | null) =>
      move.mutate({ id: conversation.id, projectId }),
    isPending: move.isPending,
  };
}

/**
 * Renames a Conversation after the user types a new title (an empty one is ignored). Used by the
 * Conversation panel's row menu.
 */
export function useRenameConversation() {
  const queryClient = useQueryClient();
  const { orpc } = useChatAdapter();
  const rename = useMutation(
    orpc.conversation.rename.mutationOptions({
      onSuccess: async (_, { id }) => {
        await queryClient.invalidateQueries({
          queryKey: orpc.conversation.get.queryKey({ input: { id } }),
        });
        await invalidateConversationList(queryClient, orpc);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const promptRename = (conversation: { id: string; title: string | null }) => {
    const next = window.prompt("Rename Conversation", conversation.title ?? "")?.trim();
    if (next && next !== conversation.title) rename.mutate({ id: conversation.id, title: next });
  };

  return { promptRename, isPending: rename.isPending };
}
