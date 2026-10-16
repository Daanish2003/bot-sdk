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
 * Downloads a Conversation's Active Branch as a Markdown file (ticket #252). From the top bar's
 * menu and ⌘K; the server names the file.
 */
export function useExportConversation() {
  const { orpc, i18n } = useChatAdapter();
  const exportMarkdown = useMutation(
    orpc.conversation.exportMarkdown.mutationOptions({
      onSuccess: ({ fileName, markdown }) => downloadText(fileName, markdown),
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  return {
    exportMarkdown: (id: string) => exportMarkdown.mutate({ id }),
    isPending: exportMarkdown.isPending,
  };
}

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers cancel the download when the URL is revoked too soon.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Moves a Conversation into a Project, or out of its Project with `null`, from its row menu. Refreshes
 * the Conversation panel's lists (the main one, Pinned and each Project's) and the Projects list.
 */
export function useMoveConversation() {
  const queryClient = useQueryClient();
  const { orpc, i18n } = useChatAdapter();
  const move = useMutation(
    orpc.conversation.move.mutationOptions({
      onSuccess: async () => {
        await invalidateConversationList(queryClient, orpc);
        await queryClient.invalidateQueries({ queryKey: orpc.project.list.key() });
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
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
