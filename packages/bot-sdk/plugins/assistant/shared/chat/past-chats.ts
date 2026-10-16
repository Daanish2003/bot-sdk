import type { MessagePart } from "@tanstack/ai";

import type { PastChatsSearchPart } from "../message-parts";

/**
 * The `search_past_chats` tool's contract, shared by the server tool, the parts boundary and the
 * web app (spec #263). No server code: safe to import into the browser.
 */

export const searchPastChatsToolName = "search_past_chats";

/** Conversations one search returns at most. */
export const maxPastChats = 5;

/** Snippets one Conversation returns at most. */
export const maxSnippetsPerChat = 3;

/** About how many characters one snippet holds. */
export const pastChatSnippetLength = 300;

/** What the Model reads when a search fails or is rate limited. */
export const searchPastChatsError = "Searching past chats failed";

/** The `search_past_chats` tool result, as the Model sees it and `useChat` streams it. */
export type SearchPastChatsOutput =
  | { conversations: PastChatsSearchPart["conversations"] }
  | { error: string };

/**
 * The search as `useChat` shows it, read from its `tool-call` part. A Shared link keeps only the
 * fact of the search: its query and Conversations are absent.
 */
export type PastChatsView = {
  toolCallId: string;
  query?: string;
  state: "done" | "error" | "running";
  conversations: PastChatsSearchPart["conversations"];
};

/**
 * The `search_past_chats` call a `useChat` part is, or `null` for any other part. The stored part
 * (`past_chats_search`) and the live stream both read as a `tool-call` named for the tool.
 */
export function pastChatsOf(part: MessagePart): PastChatsView | null {
  if (part.type !== "tool-call" || part.name !== searchPastChatsToolName) return null;
  const input = part.input as Partial<{ query: string }> | undefined;
  const output = part.output as Partial<SearchPastChatsOutput> | null | undefined;
  const meta = (part.metadata ?? {}) as Partial<{ redacted: boolean }>;
  if (meta.redacted === true) {
    return { toolCallId: part.id, state: "done", conversations: [] };
  }
  const conversations =
    output && "conversations" in output && Array.isArray(output.conversations)
      ? output.conversations
      : [];
  const state =
    part.state === "error" || (output && "error" in output)
      ? "error"
      : part.state === "complete"
        ? "done"
        : "running";
  return {
    toolCallId: part.id,
    ...(typeof input?.query === "string" && { query: input.query }),
    state,
    conversations,
  };
}
