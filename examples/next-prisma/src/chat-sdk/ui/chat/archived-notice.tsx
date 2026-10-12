import { Button } from "@/components/ui/button";

import { useArchiveConversation } from "../../core/client/react/conversation-actions";

/** Above the composer when the open Conversation is archived: it is out of the lists until Unarchive or a Message. */
export function ArchivedNotice({ conversationId }: { conversationId: string }) {
  const archive = useArchiveConversation();
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>This Conversation is archived. Sending a Message brings it back.</span>
      <Button
        size="sm"
        variant="outline"
        disabled={archive.isPending}
        onClick={() => archive.unarchive(conversationId)}
      >
        Unarchive
      </Button>
    </div>
  );
}
