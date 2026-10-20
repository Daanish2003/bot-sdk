import { fetchServerSentEvents, type UIMessage, useChat } from "@tanstack/ai-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import type { AssistantRouterClient } from "../../server/routers/index";
import type { AttachmentInfo } from "../../../../core/shared/attachments/kinds";
import type { ChatCommand } from "../../shared/chat/command";
import { branchFrom, hideReply, isModeratedChunk, messageInfo, toUIMessages } from "../chat";
import { ModeratedError } from "../../../../core/client/moderation";
import { runFetch } from "../../../../core/client/rate-limit";
import { serverErrorText } from "../../../../core/client/rpc-error";
import { invalidateConversationList } from "../../../../core/client/react/conversation-list";
import { useChatAdapter } from "../../../../core/client/react/provider";
import { readSearchPreference } from "./search-preference";

/** A Conversation as `conversation.get` returns it: its settings and its Active Branch. */
export type ConversationData = Awaited<ReturnType<AssistantRouterClient["conversation"]["get"]>>;

export type ConversationRunOptions = {
  /** Called with the refetched Conversation once a decision has started its Run. */
  onDecided: (conversation: ConversationData) => void;
  /** Called with the refetched Conversation once a joined Run's log has closed. */
  onSynced: (conversation: ConversationData) => void;
  /** Called with the text of a `send` the Host refused (#267), so the composer can put it back. */
  onRefusedSend?: (text: string) => void;
  /** Whether the selected Model can search the web; the user's preference is read with each send. */
  webSearchAvailable: boolean;
  /** The MCP connections switched on, sent with each command (spec #91). */
  connections: string[];
};

/**
 * The client side of a Conversation's Runs (ADR 0002, ADR 0006): what a chat page shows and does,
 * without its markup.
 *
 * `useChat` is the truth while a Run streams; when it ends, the Active Branch is refetched and
 * replaces `useChat`'s messages. A reply still streaming when the page opens (a reload, or a second
 * tab) is joined from its Run's log, so it continues live. A `moderated` chunk hides the reply it
 * ends (#269).
 */
export function useConversationRun(
  conversation: ConversationData,
  { onDecided, onSynced, onRefusedSend, webSearchAvailable, connections }: ConversationRunOptions,
) {
  const queryClient = useQueryClient();
  const { orpc, chatUrl, i18n } = useChatAdapter();
  const { t } = i18n;
  // The server writes the new Messages before it streams, so the first chunk means "sent".
  const awaitingFirstChunk = useRef(false);
  // The messages as of the last render, for a `moderated` chunk to hide from (#269) and a refused
  // Rating to roll back on.
  const latestMessages = useRef<UIMessage[]>([]);
  // The command for the next request. `reload` (regenerate) takes no body, so every command
  // rides in the connection's body instead.
  const command = useRef<ChatCommand>(undefined);
  // The Host's refusal of the last send (#267). @tanstack/ai turns a failed send into a RUN_ERROR that
  // keeps only the message, so the error `useChat` returns can't carry it: the fetch keeps it here (#355).
  const [refusal, setRefusal] = useState<ModeratedError | null>(null);
  const [connection] = useState(() =>
    fetchServerSentEvents(chatUrl, () => ({
      body: command.current,
      fetchClient: async (input, init) => {
        try {
          return await runFetch(input, init);
        } catch (caught) {
          if (caught instanceof ModeratedError) setRefusal(caught);
          throw caught;
        }
      },
    })),
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
    onChunk: (chunk) => {
      // A hidden reply's log ends with `moderated` (#269): its text goes from the page as it is read.
      if (isModeratedChunk(chunk)) setMessages(hideReply(latestMessages.current));
      if (!awaitingFirstChunk.current) return;
      awaitingFirstChunk.current = false;
      void invalidateConversationList(queryClient, orpc);
    },
  });
  latestMessages.current = messages;
  const [sending, setSending] = useState(false);
  // A refused send from the composer is handed back, so the user can rephrase; an edit's is not.
  const composerSend = useRef(false);
  const refusedSend = useEffectEvent((text: string) => onRefusedSend?.(text));
  useEffect(() => {
    if (refusal && composerSend.current) refusedSend(command.current?.text ?? "");
  }, [refusal]);
  const serverStreaming = conversation.messages.some((m) => m.status === "streaming");
  const conversationQuery = orpc.conversation.get.queryOptions({ input: { id: conversation.id } });
  const refetch = () => queryClient.fetchQuery({ ...conversationQuery, staleTime: 0 });

  const showServerMessages = useEffectEvent((messages: ConversationData["messages"]) => {
    if (sending) return;
    setMessages(toUIMessages(messages));
  });
  useEffect(() => showServerMessages(conversation.messages), [conversation.messages]);

  // A joined reply ends when its log closes: refetch the Conversation so the reply, the streaming
  // state and the Conversation panel row are final. A reply this page sent does this in `run`.
  const joining = useRef(false);
  const joinEnded = useEffectEvent(() => {
    void refetch()
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
    try {
      // A reply sent from this page only has `useChat`'s id; the server's is on the Active Branch.
      const fresh = await refetch();
      const running = fresh.messages.find((m) => m.status === "streaming");
      if (running) await stopRun.mutateAsync({ messageId: running.id });
    } catch (caught) {
      toast.error(t("chat.stopFailed", { message: serverErrorText(i18n, caught) }));
    }
  };

  // A Rating shows at once on its reply, and is taken back if the server refuses it. The rollback
  // reads the latest Messages, so a stream update that arrived meanwhile is kept.
  const rateCall = useMutation(orpc.chat.rate.mutationOptions());
  const withRating = (list: UIMessage[], messageId: string, rating: "up" | "down" | null) =>
    list.map((message) =>
      message.id === messageId
        ? { ...message, metadata: { ...message.metadata, rating } }
        : message,
    );
  const rate = (messageId: string, rating: "up" | "down" | null) => {
    const previous = messageInfo(messages.find((message) => message.id === messageId)!).rating;
    setMessages(withRating(messages, messageId, rating));
    rateCall.mutate(
      { messageId, rating },
      {
        onError: (caught) => {
          setMessages(withRating(latestMessages.current, messageId, previous));
          toast.error(t("chat.ratingFailed", { message: serverErrorText(i18n, caught) }));
        },
      },
    );
  };

  // The newest reply waits for its call's Approval: the composer waits too (ADR 0008).
  const decideCall = useMutation(orpc.chat.decide.mutationOptions());
  // A hidden reply lost its waiting call with its text (#268), so the composer doesn't wait on it.
  const last = messages.length > 0 ? messageInfo(messages[messages.length - 1]!) : undefined;
  const waiting = last?.status === "awaiting_approval" && !last.hidden;
  const decide = async (messageId: string, approved: boolean, allowForConversation?: boolean) => {
    // A second click while the first decision is in flight would be refused as stale.
    if (decideCall.isPending) return;
    try {
      await decideCall.mutateAsync({
        messageId,
        approved,
        allowForConversation,
        // The resumed Run offers the Web tools as a send would (ADR 0008).
        webSearch: webSearchAvailable && readSearchPreference(),
      });
    } catch (caught) {
      toast.error(t("chat.decideFailed", { message: serverErrorText(i18n, caught) }));
      return;
    }
    onDecided(await refetch());
  };

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
    setRefusal(null);
    awaitingFirstChunk.current = true;
    command.current = {
      conversationId: conversation.id,
      parentId,
      text,
      attachmentIds: attachments.map((attachment) => attachment.id),
      model: conversation.model,
      // Read now: a first Message is sent on mount, before the toggle's state has loaded.
      webSearch: webSearchAvailable && readSearchPreference(),
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
        const fresh = await refetch();
        setMessages(toUIMessages(fresh.messages));
      } finally {
        setSending(false);
        void invalidateConversationList(queryClient, orpc);
        // The Run's spend changes the meter (and a refused Run means the Quota is spent).
        void queryClient.invalidateQueries({ queryKey: orpc.quota.read.queryKey() });
      }
    }
  };

  /**
   * Edit (with `text`) or regenerate `messageId` into a new Branch beside it. An edit sends the
   * attachments the user kept and added; a regenerate leaves the user Message's alone.
   */
  const startBranch = (messageId: string, text?: string, attachments?: AttachmentInfo[]) => {
    composerSend.current = false;
    const { parentId, history } = branchFrom(messages, messageId);
    return run(parentId, text, history, attachments);
  };

  return {
    /** The Messages shown: the Active Branch, or `useChat`'s while a Run streams. */
    messages,
    /** Sends a Message from the composer, at the end of the Active Branch. */
    send: (text: string, attachments: AttachmentInfo[] = []) => {
      composerSend.current = true;
      return run(conversation.messages.at(-1)?.id ?? null, text, undefined, attachments);
    },
    /** Edits a user Message into a new Branch beside it. */
    edit: (messageId: string, text: string, attachments?: AttachmentInfo[]) =>
      startBranch(messageId, text, attachments),
    /** Regenerates a reply into a new Branch beside it. */
    regenerate: (messageId: string) => startBranch(messageId),
    /** Stops the Run streaming on the Active Branch; a failure is shown as a toast. */
    stop,
    /** Whether a Stop is in flight. */
    stopping: stopRun.isPending,
    /** Approves or denies the call a reply waits on; its next Run starts on `onDecided`. */
    decide,
    /** Rates a reply at once, and takes the Rating back if the server refuses it. */
    rate,
    /** Fetches the Conversation afresh, for a change made outside a Run (a Branch switch). */
    refetch,
    /** The Host's refusal of the last send (#267), or null. */
    refusal,
    /** The last Run's error, as `useChat` reports it. */
    error,
    /** Whether a command this page sent is still running. */
    sending,
    /** Whether a Run streams: one this page sent, or one the server has streaming. */
    streaming: sending || serverStreaming,
    /** Whether the newest reply waits for its call's Approval, so the composer waits too. */
    waiting,
  };
}
