import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { serverErrorText } from "../../../../core/client/rpc-error";
import { invalidateConversationList } from "../../../../core/client/react/conversation-list";
import { useChatAdapter } from "../../../../core/client/react/provider";

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
