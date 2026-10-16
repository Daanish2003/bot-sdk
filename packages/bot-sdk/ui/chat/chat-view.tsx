import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/prompt-kit/chat-container";
import { ScrollButton } from "@/components/ui/prompt-kit/scroll-button";
import {
  contextCutIds,
  takePendingFirstMessage,
  toUIMessages,
} from "../../plugins/assistant/client/chat";
import { contextFill, lastRunTokens } from "../../plugins/assistant/client/context-ring";
import { missingCredentialsMessage } from "../../plugins/models/client/models";
import { rateLimitedErrorOf } from "../../core/client/rate-limit";
import type { UIMessage } from "@tanstack/ai-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { toast } from "sonner";

import { useByok } from "../../plugins/models/client/react/byok";
import {
  type ConversationData,
  useConversationRun,
} from "../../plugins/assistant/client/react/conversation-run";
import { useChatAdapter, useI18n } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";
import { useQuota } from "../../plugins/models/client/react/quota";
import { quotaBlocksModel } from "../../plugins/models/client/quota";

import { AttachButton, DraftAttachmentChips, useAttachmentDraft } from "./attachments";
import { Composer } from "./composer";
import { ArtifactPanel, artifactVersionsOn, LiveArtifactPanel } from "./artifact-panel";
import { artifactIdOf, type ArtifactRef } from "./artifact-card";
import {
  artifactCallsIn,
  type PanelTarget,
  panelTargetOf,
  rememberSaved,
  startedArtifactCalls,
} from "./artifact-live";
import { ContextOverflowNotice, ContextRing } from "./context-ring";
import { editSourcesOf, MessageRow } from "./message-row";
import { ArchivedNotice } from "./archived-notice";
import { MissingCredentialsBanner } from "./missing-credentials-banner";
import { QuotaBanner } from "./quota-banner";
import { TemporaryBanner } from "./temporary-banner";
import { QuotaMeter } from "./quota-meter";
import { SearchToggle, useWebSearch } from "./search-toggle";
import { ToolsMenu } from "./tools-menu";
import { mcpToolsMenu, switchConnection } from "../../plugins/assistant/client/mcp-tools";
import { useFocusMessage } from "./use-focus-message";

export type { ConversationData };

type ChatViewProps = {
  conversation: ConversationData;
  /** A search hit to land on: its Branch is shown, then it's scrolled to and highlighted. */
  focusMessageId?: string;
  /** Called once `focusMessageId` has been landed on (or couldn't be). */
  onFocused?: () => void;
};

/**
 * One Conversation's Active Branch and composer. A decision on a call that waits for Approval starts
 * the reply's next Run (ADR 0008): the page restarts on the refetched Conversation, which joins that
 * Run's log as a reload does, so the restart is a fresh `ChatThread`.
 */
export function ChatView(props: ChatViewProps) {
  const [restarted, setRestarted] = useState<{
    conversation: ConversationData;
    generation: number;
  }>();
  // What the side panel shows: a saved Artifact version, or a call still streaming (spec #304). It
  // lives here, not in the thread, so a restart of the thread leaves the panel as it was.
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  // The Messages the thread shows, as it streams, so the panel can follow an Artifact call in them.
  const [messages, setMessages] = useState<UIMessage[]>(() =>
    toUIMessages(props.conversation.messages),
  );
  const shown = panel ? panelTargetOf(messages, panel) : null;
  // The Artifact's newest version on the Branch, which an update that the panel shows changes.
  const updated = shown?.kind === "live" ? artifactIdOf(shown.call) : undefined;
  const latest = updated === undefined ? undefined : artifactVersionsOn(messages, updated)[0];
  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <ChatThread
          key={restarted?.generation ?? 0}
          {...props}
          conversation={restarted?.conversation ?? props.conversation}
          onDecided={(conversation) =>
            setRestarted({ conversation, generation: (restarted?.generation ?? 0) + 1 })
          }
          // The restarted snapshot is the decision's, still streaming. Once its join ends, the
          // refetched Conversation replaces it, or the page would keep showing the reply as streaming.
          onSynced={(conversation) =>
            setRestarted((current) => (current ? { ...current, conversation } : current))
          }
          onOpenArtifact={(ref) => setPanel({ kind: "saved", ref })}
          onStreamArtifact={(callId) => setPanel({ kind: "live", callId })}
          onMessages={(current) => {
            setMessages(current);
            setPanel((target) =>
              target?.kind === "live" ? rememberSaved(target, current) : target,
            );
          }}
        />
      </div>
      {shown?.kind === "saved" && (
        <ArtifactPanel
          key={`${shown.ref.artifactId}:${shown.ref.version}`}
          artifact={shown.ref}
          // The versions on the Active Branch only, so the dropdown never lists another Branch's.
          versions={artifactVersionsOn(messages, shown.ref.artifactId)}
          onSelect={(ref) => setPanel({ kind: "saved", ref })}
          onClose={() => setPanel(null)}
        />
      )}
      {shown?.kind === "live" && (
        <LiveArtifactPanel
          key={shown.call.id}
          call={shown.call}
          latest={latest}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}

/**
 * One Conversation's Active Branch and composer. Its Runs (sending, joining, Stop, Approval,
 * Rating, Memory events) are `useConversationRun`'s, in `core/`; this is the markup around them.
 */
function ChatThread({
  conversation,
  focusMessageId,
  onFocused = () => {},
  onDecided,
  onSynced,
  onOpenArtifact,
  onStreamArtifact,
  onMessages,
}: ChatViewProps & {
  /** Called with the refetched Conversation once a decision has started its Run. */
  onDecided: (conversation: ConversationData) => void;
  /** Called with the refetched Conversation once a joined Run's log has closed. */
  onSynced: (conversation: ConversationData) => void;
  /** Opens an Artifact version in the side panel beside the chat (spec #304). */
  onOpenArtifact: (ref: ArtifactRef) => void;
  /** Opens the side panel on an Artifact call as it first streams in (spec #304). */
  onStreamArtifact: (callId: string) => void;
  /** Reports the Messages the thread shows, as they change. */
  onMessages: (messages: UIMessage[]) => void;
}) {
  const { orpc } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  // The composer's text. A Message the Host refuses (#267) is put back in it, so the user can rephrase.
  const [composerText, setComposerText] = useState("");
  // The selected Model's Provider may have lost its credentials; the server re-checks on send.
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const blocked = models.data
    ? missingCredentialsMessage(i18n, conversation.model, models.data.models, byok)
    : null;
  // A spent Quota blocks the selected Model only when it's a Host Model; the user's own still runs.
  const quota = useQuota().data;
  const selectedModel = models.data?.models.find((model) => model.id === conversation.model);
  const quotaBlocked = quotaBlocksModel(selectedModel, quota);
  // The context ring: the last Run's tokens on this Branch, against the selected Model's window.
  const context = contextFill(
    lastRunTokens(conversation.messages),
    selectedModel?.contextWindow ?? null,
  );
  const search = useWebSearch(conversation.model);

  // The MCP tools switched on (spec #91). Before the first Message they live in the composer and go
  // with the first send; after it, each switch is stored with the Conversation.
  const firstMessage = conversation.messages.length === 0;
  const [composerConnections, setComposerConnections] = useState<string[]>([]);
  const connections = firstMessage ? composerConnections : conversation.tools.connections;
  const servers = useQuery(orpc.connections.list.queryOptions());
  const setConnections = useMutation(
    orpc.conversation.setConnections.mutationOptions({
      onSuccess: () => refetch(),
      onError: (caught) =>
        toast.error(t("chat.toolSwitchFailed", { message: serverErrorText(i18n, caught) })),
    }),
  );
  const toolItems = mcpToolsMenu(servers.data?.servers ?? [], connections);
  const toggleTool = (key: string, on: boolean) => {
    const next = switchConnection(connections, key, on);
    if (firstMessage) setComposerConnections(next);
    else setConnections.mutate({ id: conversation.id, connections: next });
  };

  const draft = useAttachmentDraft(conversation.model);

  const {
    messages,
    send,
    edit,
    regenerate,
    stop,
    stopping,
    decide,
    rate,
    refetch,
    refusal,
    error,
    sending,
    streaming,
    waiting,
  } = useConversationRun(conversation, {
    onDecided,
    onSynced,
    onRefusedSend: setComposerText,
    webSearchAvailable: search.available,
    connections,
  });

  // The panel opens on an Artifact call from its first delta (spec #304). The calls already done when
  // the page opens (or a decision restarts it) are not followed again; a call still running is.
  const [followed] = useState(
    () =>
      new Set(
        artifactCallsIn(toUIMessages(conversation.messages))
          .filter(({ call }) => call.status !== "running")
          .map(({ call }) => call.id),
      ),
  );
  const reportMessages = useEffectEvent((current: UIMessage[]) => {
    onMessages(current);
    for (const { call } of startedArtifactCalls(current, followed)) onStreamArtifact(call.id);
  });
  useEffect(() => reportMessages(messages), [messages]);

  const switchBranch = useMutation(
    orpc.conversation.switchBranch.mutationOptions({
      onSuccess: () => refetch(),
      onError: (caught) =>
        toast.error(t("chat.branchSwitchFailed", { message: serverErrorText(i18n, caught) })),
    }),
  );

  // The Messages the Model's context starts at, on the Branch shown (issue #122).
  const contextCuts = contextCutIds(messages);
  const editSources = editSourcesOf(messages);

  const highlighted = useFocusMessage({
    target: focusMessageId,
    onScreen: messages.map((message) => message.id),
    activeBranch: conversation.messages.map((message) => message.id),
    switchBranch: (messageId) => switchBranch.mutateAsync({ messageId }),
    onFocused,
  });

  // A new Conversation arrives here with its first Message still to send. Taken a tick later:
  // StrictMode's throwaway first mount would otherwise take it and drop it on unmount.
  const sendPendingFirstMessage = useEffectEvent(() => {
    const pending = takePendingFirstMessage(conversation.id);
    if (pending) void send(pending.text, pending.attachments);
  });
  useEffect(() => {
    const timer = setTimeout(sendPendingFirstMessage);
    return () => clearTimeout(timer);
  }, [conversation.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {conversation.temporary && <TemporaryBanner />}
      <ChatContainerRoot className="relative min-h-0 flex-1">
        <ChatContainerContent className="py-2">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              highlighted={message.id === highlighted}
              editSources={editSources}
              contextCut={contextCuts.has(message.id)}
              onOpenArtifact={onOpenArtifact}
              latestVersionOf={(artifactId) => artifactVersionsOn(messages, artifactId)[0]?.version}
              actions={{
                streaming: streaming || switchBranch.isPending,
                model: conversation.model,
                onEdit: (text, attachments) => void edit(message.id, text, attachments),
                onRegenerate: () => void regenerate(message.id),
                onSwitchBranch: (messageId) => switchBranch.mutate({ messageId }),
                onRate: (rating) => rate(message.id, rating),
                onDecide: (approved, allowForConversation) =>
                  void decide(message.id, approved, allowForConversation),
              }}
            />
          ))}
        </ChatContainerContent>
        <div className="absolute right-6 bottom-3">
          <ScrollButton />
        </div>
      </ChatContainerRoot>
      <div className="border-t bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
          {/* A refused Run is explained by the Quota banner below, not by its error. */}
          {error && !sending && !quotaBlocked && !refusal && (
            <p role="alert" className="text-xs text-destructive">
              {rateLimitedErrorOf(error) ? t("chat.tooManyMessages") : serverErrorText(i18n, error)}
            </p>
          )}
          <QuotaMeter />
          {conversation.archivedAt && !streaming && (
            <ArchivedNotice conversationId={conversation.id} />
          )}
          {blocked && <MissingCredentialsBanner message={blocked} />}
          {quotaBlocked && quota && <QuotaBanner resetsAt={quota.resetsAt} />}
          <ContextOverflowNotice fill={context} />
          <Composer
            value={composerText}
            onValueChange={setComposerText}
            refusal={refusal ? refusal.message || t("chat.moderatedDefault") : null}
            onSend={(text) => {
              void send(text, draft.uploaded);
              draft.clear();
            }}
            attachments={<DraftAttachmentChips draft={draft} />}
            attachmentsPending={draft.pending}
            onStop={stopping ? undefined : () => void stop()}
            streaming={streaming}
            // The next Message continues the Branch being switched to, so wait for it.
            disabled={!!blocked || quotaBlocked || switchBranch.isPending || waiting}
            placeholder={waiting ? t("chat.approveFirst") : undefined}
          >
            <AttachButton draft={draft} disabled={!!blocked || quotaBlocked} />
            <SearchToggle search={search} />
            <ToolsMenu items={toolItems} onToggle={toggleTool} />
            <ContextRing fill={context} />
          </Composer>
        </div>
      </div>
    </div>
  );
}
