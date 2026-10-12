import { setPendingFirstMessage } from "../../core/client/chat";
import { missingCredentialsMessage } from "../../core/client/models";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { AttachButton, DraftAttachmentChips, useAttachmentDraft } from "../chat/attachments";
import { Composer } from "../chat/composer";
import { MissingCredentialsBanner } from "../chat/missing-credentials-banner";
import { NoCredentials } from "../chat/no-credentials";
import { SearchToggle, useWebSearch } from "../chat/search-toggle";
import { Welcome } from "../chat/welcome";
import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useByok } from "../../core/client/react/byok";
import {
  setNewConversationEffort,
  useNewConversationEffort,
} from "../../core/client/react/new-conversation-effort";
import { useNewConversationModel } from "../../core/client/react/new-conversation-model";
import { useChatAdapter, useChatLocation } from "../../core/client/react/provider";

/**
 * A new Conversation: type the first Message; it's created with the picked Model (the location's
 * `newConversationModel`, else `models.list`'s default) when sent, inside the location's Project
 * when it has one.
 */
export function NewConversationPage() {
  const { orpc, navigate } = useChatAdapter();
  const queryClient = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const { model } = useNewConversationModel();
  const { projectId } = useChatLocation();
  const { effort } = useNewConversationEffort();
  // A pick belongs to this new Conversation: leaving the page without sending drops it.
  useEffect(() => () => setNewConversationEffort(null), []);
  const create = useMutation(orpc.conversation.create.mutationOptions());
  const blocked =
    models.data && model ? missingCredentialsMessage(model, models.data.models, byok) : null;
  const disabled = !model || !!blocked || create.isPending;
  const draft = useAttachmentDraft(model);
  const search = useWebSearch(model);

  const start = async (text: string) => {
    if (!model) return;
    const attachments = draft.uploaded;
    try {
      const { id } = await create.mutateAsync({ model, reasoningEffort: effort, projectId });
      // The choice is stored on the Conversation now; the next new one starts at the Model's default.
      setNewConversationEffort(null);
      void invalidateConversationList(queryClient, orpc);
      setPendingFirstMessage(id, { text, attachments });
      await navigate({ to: "conversation", id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the Conversation");
    }
  };

  if (models.data?.models.length === 0) return <NoCredentials />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <main className="flex flex-1 items-center justify-center p-6">
        <Welcome onSuggest={(text) => void start(text)} disabled={disabled} />
      </main>
      <div className="border-t bg-background px-3 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
          {blocked && <MissingCredentialsBanner message={blocked} />}
          <Composer
            onSend={(text) => void start(text)}
            disabled={disabled}
            attachments={<DraftAttachmentChips draft={draft} />}
            attachmentsPending={draft.pending}
          >
            <AttachButton draft={draft} disabled={!model || !!blocked} />
            <SearchToggle search={search} />
          </Composer>
        </div>
      </div>
    </div>
  );
}
