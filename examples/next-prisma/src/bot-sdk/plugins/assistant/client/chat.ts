import { reconnectChatgptMessage } from "../../models/shared/chatgpt-plan";
import type { I18n } from "../../../core/shared/i18n";
import type { AttachmentInfo } from "../../../core/shared/attachments/kinds";
import type { SiblingPosition } from "../../../core/shared/chat/branches";
import type { ActiveBranchMessage, ClientMessage } from "../shared/chat/client-message";
import type { SharedConversation } from "../shared/share/conversation";
import type { TurnChange } from "../shared/memory/changes";
import type { UIMessage } from "@tanstack/ai-client";

/** What the server knows about a Message beyond its parts, kept in `UIMessage.metadata`. */
export type MessageInfo = Pick<
  ClientMessage,
  "model" | "reasoningEffort" | "status" | "error" | "errorReason" | "usage" | "rating" | "hidden"
> & {
  /** What the Memory job changed for this reply's turn, for its "Memory updated" chip (#290). */
  memoryChanges: TurnChange[];
};

/**
 * An attachment as a chip. A Shared link shows only its filename and type; the user's own
 * Messages also have its id and size.
 */
export type AttachmentChip = Pick<AttachmentInfo, "filename" | "mediaType"> &
  Partial<Pick<AttachmentInfo, "id" | "size">>;

/** `useChat` messages from the Active Branch (`conversation.get`). */
export function toUIMessages(messages: ActiveBranchMessage[]): UIMessage[] {
  return messages.map(
    ({
      id,
      role,
      parts,
      createdAt,
      model,
      reasoningEffort,
      status,
      error,
      errorReason,
      usage,
      rating,
      contextStartId,
      hidden,
      siblings,
      attachments,
      memoryChanges,
    }) => ({
      id,
      role,
      parts: parts as UIMessage["parts"],
      createdAt,
      metadata: {
        model,
        reasoningEffort,
        status,
        error,
        errorReason,
        usage,
        rating,
        hidden,
        memoryChanges,
        contextStartId,
        siblings,
        attachments,
      } satisfies MessageInfo & {
        siblings: SiblingPosition;
        attachments: AttachmentChip[];
        contextStartId: string | null;
      },
    }),
  );
}

/**
 * The Message a reply's context starts at, when the Model's window dropped older Messages for it
 * (issue #122); null otherwise, and always null on a Shared link.
 */
function messageContextStart(message: UIMessage): string | null {
  const info = message.metadata as { contextStartId?: string | null } | undefined;
  return info?.contextStartId ?? null;
}

/**
 * The Messages of a Branch that the context marker sits above: each reply's context start, among
 * the Messages passed in. Pass only one Branch's Messages, so each Branch shows its own cut-off.
 */
export function contextCutIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const start = messageContextStart(message);
    if (start !== null && messages.some((other) => other.id === start)) ids.add(start);
  }
  return ids;
}

/** A Shared link's Messages, for read-only `MessageRow`s. */
export function sharedToUIMessages(messages: SharedConversation["messages"]): UIMessage[] {
  return messages.map(({ id, role, parts, attachments, createdAt, model, status, hidden }) => ({
    id,
    role,
    parts: parts as UIMessage["parts"],
    createdAt,
    metadata: {
      model,
      // A Shared link carries no reasoning effort.
      reasoningEffort: null,
      status,
      error: null,
      errorReason: null,
      usage: null,
      // A Shared link carries no Ratings, and no Memory changes (#290).
      rating: null,
      hidden,
      memoryChanges: [],
      attachments,
    } satisfies MessageInfo & {
      attachments: AttachmentChip[];
    },
  }));
}

/** The files a Message carries, kept in `UIMessage.metadata`; none for a reply. */
export function messageAttachments(message: UIMessage): AttachmentChip[] {
  const info = message.metadata as { attachments?: AttachmentChip[] } | undefined;
  return info?.attachments ?? [];
}

/** Where the Message sits among its siblings, for the ‹ n/m › arrows; 1 of 1 while it streams. */
export function messageSiblings(message: UIMessage): SiblingPosition {
  const info = message.metadata as { siblings?: SiblingPosition } | undefined;
  return info?.siblings ?? { index: 0, count: 1, previousId: null, nextId: null };
}

/**
 * Editing or regenerating `messageId` starts a new Branch beside it: the command goes under the
 * same parent, and the messages shown before it stay while the new reply streams.
 */
export function branchFrom<T extends { id: string }>(messages: T[], messageId: string) {
  const history = messages.slice(
    0,
    messages.findIndex((message) => message.id === messageId),
  );
  return { parentId: history.at(-1)?.id ?? null, history };
}

/**
 * The server's view of a Message. A message `useChat` is streaming has none yet, so it counts as
 * `streaming` until the run ends and the Active Branch is refetched.
 */
export function messageInfo(message: UIMessage): MessageInfo {
  const info = message.metadata as Partial<MessageInfo> | undefined;
  return {
    model: info?.model ?? null,
    reasoningEffort: info?.reasoningEffort ?? null,
    status: info?.status ?? "streaming",
    error: info?.error ?? null,
    errorReason: info?.errorReason ?? null,
    usage: info?.usage ?? null,
    rating: info?.rating ?? null,
    hidden: info?.hidden ?? false,
    memoryChanges: info?.memoryChanges ?? [],
  };
}

/**
 * The Messages with one reply's Memory changes replaced, as the live `memory_updated` event sends
 * them (#290). Other Messages are passed through as they are.
 */
export function withMemoryChanges(
  messages: UIMessage[],
  messageId: string,
  changes: TurnChange[],
): UIMessage[] {
  return messages.map((message) =>
    message.id === messageId
      ? { ...message, metadata: { ...message.metadata, memoryChanges: changes } }
      : message,
  );
}

/** Whether a stream chunk is the `moderated` custom chunk that ends a hidden reply's Run log (#269). */
export function isModeratedChunk(chunk: { type: string; name?: string }): boolean {
  return chunk.type === "CUSTOM" && chunk.name === "moderated";
}

/**
 * The reply a `moderated` chunk hides (#269): every assistant Message after the last user Message,
 * since a reply can span several Runs. Its parts are dropped and it reads as hidden.
 */
export function hideReply(messages: UIMessage[]): UIMessage[] {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  return messages.map((message, index) =>
    index > lastUser && message.role === "assistant"
      ? { ...message, parts: [], metadata: { ...message.metadata, hidden: true } }
      : message,
  );
}

/** What to tell the user about a Message that ended in `error`, and whether to link Key settings. */
export function describeError({ t }: I18n, { error, errorReason }: MessageInfo) {
  switch (errorReason) {
    case "invalid_key":
      return { text: t("chat.errorInvalidKey"), keySettings: true };
    case "rate_limited":
      return { text: t("chat.errorRateLimited"), keySettings: false };
    case "provider_error":
      // A Run on a broken ChatGPT link (ADR 0023) stores the reconnect message, maybe after a status.
      if (error?.endsWith(reconnectChatgptMessage)) {
        return { text: t("chat.errorReconnectChatgpt"), keySettings: true };
      }
      return {
        text: error ? t("chat.errorProviderWith", { error }) : t("chat.errorProvider"),
        keySettings: false,
      };
  }
  // Errors with no reason are the run's own guards (ADR 0002).
  // A stored code (spec #256); a row written before codes says "timed out", which reads the same.
  const text =
    error === "timed_out" || error === "timed out"
      ? t("chat.errorTimedOut")
      : error === "interrupted"
        ? t("chat.errorInterrupted")
        : (error ?? t("chat.errorGeneric"));
  return { text, keySettings: false };
}

/**
 * The first Message of a new Conversation, typed before it existed: the new Conversation
 * page creates it, navigates to `/c/$id`, and that page sends it.
 */
type PendingFirstMessage = { text: string; attachments: AttachmentInfo[] };

const pendingFirstMessages = new Map<string, PendingFirstMessage>();

export function setPendingFirstMessage(conversationId: string, pending: PendingFirstMessage) {
  pendingFirstMessages.set(conversationId, pending);
}

/** The pending first Message, handed out once. */
export function takePendingFirstMessage(conversationId: string) {
  const pending = pendingFirstMessages.get(conversationId);
  pendingFirstMessages.delete(conversationId);
  return pending;
}
