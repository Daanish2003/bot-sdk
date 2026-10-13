import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { AppDeps } from "../deps";
import { rateLimitedFor } from "../rate-limits";
import type { createPartsBuilder } from "../../shared/chat/parts";
import {
  type SearchPastChatsOutput,
  searchPastChatsError,
  searchPastChatsToolName,
} from "../../shared/chat/past-chats";
import { searchPastChats } from "../search/past-chats";

const searchPastChatsDefinition = toolDefinition({
  name: searchPastChatsToolName,
  description:
    "Search the user's earlier chats for words they or the assistant used, and return the matching " +
    "Conversations (up to 5) with their title, date, id and snippets. Use it when the user asks " +
    "about something discussed before, such as what was decided last week.",
  inputSchema: z.object({
    query: z.string().min(1).meta({
      description: "The words to look for, such as 'drizzle migration'. Every word must appear.",
    }),
  }),
});

/**
 * The `search_past_chats` server tool for one reply (spec #263). It searches the user's earlier
 * Conversations in the Run's scope and records the search in the reply's `parts`, calling
 * `onChange` when they change. It is free (no usage row) and shares the per-user Conversation
 * search rate limit: over it, the search fails as a state and the reply continues.
 */
export function createSearchPastChatsTool({
  deps,
  userId,
  conversationId,
  projectId,
  parts,
  onChange,
}: {
  deps: AppDeps;
  userId: string;
  conversationId: string;
  /** The current Conversation's Project, or null for a general Conversation. */
  projectId: string | null;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
}) {
  return searchPastChatsDefinition.server(
    async ({ query }, context): Promise<SearchPastChatsOutput> => {
      // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
      const toolCallId = context?.toolCallId;
      if (!toolCallId) throw new Error("search_past_chats was called without a tool call id");
      parts.startPastChats(toolCallId, query);
      onChange();
      try {
        const retryAfter = await rateLimitedFor(
          deps.counters,
          deps.rateLimits.conversationSearch,
          `conversationSearch:${userId}`,
        );
        if (retryAfter !== null) {
          parts.finishPastChats(toolCallId, "error");
          return { error: searchPastChatsError };
        }
        const conversations = await searchPastChats(
          deps,
          { userId, conversationId, projectId },
          query,
        );
        parts.finishPastChats(toolCallId, { conversations });
        return { conversations };
      } catch (caught) {
        // A search cut off by the run ending stays running; the run closes it as cancelled.
        if (context?.abortSignal?.aborted) throw caught;
        deps.logger.error(`Searching past chats of ${userId} failed`, caught);
        parts.finishPastChats(toolCallId, "error");
        return { error: searchPastChatsError };
      } finally {
        onChange();
      }
    },
  );
}
