import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";

import { useDeleteConversation } from "../../core/client/react/delete-conversation";
import { useI18n, useOrpc } from "../../core/client/react/provider";
import { ShareButton } from "../share/share-dialog";

/**
 * The header's delete action in a Temporary Conversation. Such a Conversation isn't in the sidebar,
 * so it's deleted from here, through the normal delete path.
 */
export function TemporaryHeaderActions({ onDelete }: { onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost" size="sm" aria-label={t("shell.deleteConversation")} onClick={onDelete}>
      <Trash2Icon /> <span className="max-sm:hidden">{t("shell.delete")}</span>
    </Button>
  );
}

/**
 * The header's actions for the open Conversation: Share, or Delete in a Temporary Conversation
 * (where Share is hidden, since a Temporary Conversation can't be shared).
 */
export function ConversationHeaderActions({ id }: { id: string }) {
  const orpc = useOrpc();
  const conversation = useQuery(orpc.conversation.get.queryOptions({ input: { id } }));
  const remove = useDeleteConversation();
  const data = conversation.data;
  if (!data) return null;
  if (data.temporary) {
    return (
      <TemporaryHeaderActions
        onDelete={() => remove.confirmDelete({ id, title: data.title, shared: false })}
      />
    );
  }
  return <ShareButton conversationId={id} />;
}
