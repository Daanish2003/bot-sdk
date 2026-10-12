import type { AttachmentInfo } from "../../core/shared/attachments/kinds";
import type { AppRouterClient } from "../../core/server/routers/index";
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/prompt-kit/chat-container";
import { ScrollButton } from "@/components/ui/prompt-kit/scroll-button";
import type { ChatCommand } from "../../core/shared/chat/command";
import {
  branchFrom,
  contextCutIds,
  messageInfo,
  takePendingFirstMessage,
  toUIMessages,
} from "../../core/client/chat";
import { contextFill, lastRunTokens } from "../../core/client/context-ring";
import { missingCredentialsMessage } from "../../core/client/models";
import { rateLimitedErrorOf, runFetch } from "../../core/client/rate-limit";
import { fetchServerSentEvents, type UIMessage, useChat } from "@tanstack/ai-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useByok } from "../../core/client/react/byok";
import { useChatAdapter } from "../../core/client/react/provider";
import { useQuota } from "../../core/client/react/quota";
import { readSearchPreference } from "../../core/client/react/search-preference";
import { quotaBlocksModel } from "../../core/client/quota";

import { AttachButton, DraftAttachmentChips, useAttachmentDraft } from "./attachments";
import { Composer } from "./composer";
import { ContextOverflowNotice, ContextRing } from "./context-ring";
import { MessageRow } from "./message-row";
import { MissingCredentialsBanner } from "./missing-credentials-banner";
import { QuotaBanner } from "./quota-banner";
import { QuotaMeter } from "./quota-meter";
import { SearchToggle, useWebSearch } from "./search-toggle";
import { ToolsMenu } from "./tools-menu";
import { mcpToolsMenu, switchConnection } from "../../core/client/mcp-tools";
import { useFocusMessage } from "./use-focus-message";

export type ConversationData = Awaited<ReturnType<AppRouterClient["conversation"]["get"]>>;

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
  return (
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
    />
  );
}

/**
 * One Conversation's Active Branch and composer. `useChat` is the truth while a run streams;
 * when it ends, the Active Branch is refetched and replaces `useChat`'s messages (ADR 0002).
 * A reply still streaming when the page opens (a reload, or a second tab) is joined from its
 * Run's log, so it continues live (ADR 0006).
 */
function ChatThread({
  conversation,
  focusMessageId,
  onFocused = () => {},
  onDecided,
  onSynced,
}: ChatViewProps & {
  /** Called with the refetched Conversation once a decision has started its Run. */
  onDecided: (conversation: ConversationData) => void;
  /** Called with the refetched Conversation once a joined Run's log has closed. */
  onSynced: (conversation: ConversationData) => void;
}) {
  const queryClient = useQueryClient();
  const { orpc, chatUrl } = useChatAdapter();
  // The server writes the new Messages before it streams, so the first chunk means "sent".
  const awaitingFirstChunk = useRef(false);
  // The command for the next request. `reload` (regenerate) takes no body, so every command
  // rides in the connection's body instead.
  const command = useRef<ChatCommand>(undefined);
  const [connection] = useState(() =>
    fetchServerSentEvents(chatUrl, () => ({ body: command.current, fetchClient: runFetch })),
  );
  // A reply that is streaming when the page opens is joined: its Message id is its Run's id.
  const [joinedRunId] = useState(
    () => conversation.messages.find((m) => m.status === "streaming")?.id,
  );
  const { messages, sendMessage, reload, setMessages, error, isLoading } = useChat({
    connection,
    initialMessages: toUIMessages(conversation.messages),
    initialResumeSnapshot: joinedRunId
      ? { resumeState: { threadId: conversation.id, runId: joinedRunId } }
      : undefined,
    onChunk: () => {
      if (!awaitingFirstChunk.current) return;
      awaitingFirstChunk.current = false;
      void invalidateConversationList(queryClient, orpc);
    },
  });
  const [sending, setSending] = useState(false);
  const serverStreaming = conversation.messages.some((m) => m.status === "streaming");
  const streaming = sending || serverStreaming;
  const conversationQuery = orpc.conversation.get.queryOptions({ input: { id: conversation.id } });
  const fetchConversation = () => queryClient.fetchQuery({ ...conversationQuery, staleTime: 0 });

  const showServerMessages = useEffectEvent((messages: ConversationData["messages"]) => {
    if (sending) return;
    setMessages(toUIMessages(messages));
  });
  useEffect(() => showServerMessages(conversation.messages), [conversation.messages]);

  // A joined reply ends when its log closes: refetch the Conversation so the reply, the streaming
  // state and the Conversation panel row are final. A reply this page sent does this in `run`.
  const joining = useRef(false);
  const joinEnded = useEffectEvent(() => {
    void fetchConversation()
      .then(onSynced)
      .finally(() => invalidateConversationList(queryClient, orpc));
  });
  useEffect(() => {
    if (isLoading) {
      joining.current = true;
      return;
    }
    if (!joining.current) return;
    joining.current = false;
    if (!sending) joinEnded();
  }, [isLoading, sending]);

  const stopRun = useMutation(orpc.chat.stop.mutationOptions());
  const stop = async () => {
    // A reply sent from this page only has `useChat`'s id; the server's is on the Active Branch.
    const fresh = await fetchConversation();
    const running = fresh.messages.find((m) => m.status === "streaming");
    if (running) await stopRun.mutateAsync({ messageId: running.id });
  };

  // The newest reply waits for its call's Approval: the composer waits too (ADR 0008).
  const decideCall = useMutation(orpc.chat.decide.mutationOptions());
  const waiting =
    messages.length > 0 &&
    messageInfo(messages[messages.length - 1]!).status === "awaiting_approval";
  const decide = async (messageId: string, approved: boolean, allowForConversation?: boolean) => {
    // A second click while the first decision is in flight would be refused as stale.
    if (decideCall.isPending) return;
    try {
      await decideCall.mutateAsync({ messageId, approved, allowForConversation });
    } catch (caught) {
      toast.error(`Deciding failed: ${(caught as Error).message}`);
      return;
    }
    onDecided(await fetchConversation());
  };

  // The selected Model's Provider may have lost its credentials; the server re-checks on send.
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const blocked = models.data
    ? missingCredentialsMessage(conversation.model, models.data.models, byok)
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
      onSuccess: () => fetchConversation(),
      onError: (caught) => toast.error(`Switching a tool failed: ${caught.message}`),
    }),
  );
  const toolItems = mcpToolsMenu(servers.data?.servers ?? [], connections);
  const toggleTool = (key: string, on: boolean) => {
    const next = switchConnection(connections, key, on);
    if (firstMessage) setComposerConnections(next);
    else setConnections.mutate({ id: conversation.id, connections: next });
  };

  const draft = useAttachmentDraft(conversation.model);

  /**
   * Runs a command under `parentId`: a send or an edit with `text`, a regenerate without.
   * A new Branch replaces what's on screen with `history`, the Messages above the new ones.
   * `attachments` are the new Message's files; an edit passes the full list it keeps.
   */
  const run = async (
    parentId: string | null,
    text?: string,
    history?: UIMessage[],
    attachments: AttachmentInfo[] = [],
  ) => {
    setSending(true);
    awaitingFirstChunk.current = true;
    command.current = {
      conversationId: conversation.id,
      parentId,
      text,
      attachmentIds: attachments.map((attachment) => attachment.id),
      model: conversation.model,
      // Read now: a first Message is sent on mount, before the toggle's state has loaded.
      webSearch: search.available && readSearchPreference(),
      // Read with the send: the first Message takes the composer's choice (the server ignores it later).
      tools: { connections, allowedTools: [] },
    };
    try {
      if (history) setMessages(history);
      // The attachments ride along in the metadata so their chips show while the reply streams.
      await (text === undefined
        ? reload()
        : sendMessage({ content: text, metadata: { attachments } }));
    } finally {
      try {
        const fresh = await fetchConversation();
        setMessages(toUIMessages(fresh.messages));
      } finally {
        setSending(false);
        void invalidateConversationList(queryClient, orpc);
        // The Run's spend changes the meter (and a refused Run means the Quota is spent).
        void queryClient.invalidateQueries({ queryKey: orpc.quota.read.queryKey() });
      }
    }
  };

  const send = (text: string, attachments: AttachmentInfo[] = []) =>
    run(conversation.messages.at(-1)?.id ?? null, text, undefined, attachments);

  /**
   * Edit (with `text`) or regenerate `messageId` into a new Branch beside it. An edit sends the
   * attachments the user kept and added; a regenerate leaves the user Message's alone.
   */
  const startBranch = (messageId: string, text?: string, attachments?: AttachmentInfo[]) => {
    const { parentId, history } = branchFrom(messages, messageId);
    void run(parentId, text, history, attachments);
  };

  const switchBranch = useMutation(
    orpc.conversation.switchBranch.mutationOptions({
      onSuccess: () => fetchConversation(),
      onError: (caught) => toast.error(`Switching Branch failed: ${caught.message}`),
    }),
  );

  // The Messages the Model's context starts at, on the Branch shown (issue #122).
  const contextCuts = contextCutIds(messages);

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
      <ChatContainerRoot className="relative min-h-0 flex-1">
        <ChatContainerContent className="py-2">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              highlighted={message.id === highlighted}
              contextCut={contextCuts.has(message.id)}
              actions={{
                streaming: streaming || switchBranch.isPending,
                model: conversation.model,
                onEdit: (text, attachments) => startBranch(message.id, text, attachments),
                onRegenerate: () => startBranch(message.id),
                onSwitchBranch: (messageId) => switchBranch.mutate({ messageId }),
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
      <div className="border-t bg-background px-3 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
          {/* A refused Run is explained by the Quota banner below, not by its error. */}
          {error && !sending && !quotaBlocked && (
            <p role="alert" className="text-xs text-destructive">
              {rateLimitedErrorOf(error)
                ? "Too many messages. Try again in a moment."
                : error.message}
            </p>
          )}
          <QuotaMeter />
          {blocked && <MissingCredentialsBanner message={blocked} />}
          {quotaBlocked && quota && <QuotaBanner resetsAt={quota.resetsAt} />}
          <ContextOverflowNotice fill={context} />
          <Composer
            onSend={(text) => {
              void send(text, draft.uploaded);
              draft.clear();
            }}
            attachments={<DraftAttachmentChips draft={draft} />}
            attachmentsPending={draft.pending}
            onStop={
              stopRun.isPending
                ? undefined
                : () =>
                    stop().catch((caught: Error) =>
                      toast.error(`Stopping failed: ${caught.message}`),
                    )
            }
            streaming={streaming}
            // The next Message continues the Branch being switched to, so wait for it.
            disabled={!!blocked || quotaBlocked || switchBranch.isPending || waiting}
            placeholder={waiting ? "Approve or deny the tool call first" : undefined}
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
