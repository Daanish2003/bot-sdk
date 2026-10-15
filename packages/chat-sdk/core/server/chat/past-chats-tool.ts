import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { AppDeps } from "../deps";
import { rateLimitedFor } from "../rate-limits";
import {
  type SearchPastChatsOutput,
  searchPastChatsError,
  searchPastChatsToolName,
} from "../../shared/chat/past-chats";
import { searchPastChats } from "../search/past-chats";
import { type RunToolState, trackedTool } from "./tracked-tool";

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
 * Conversations in the Run's scope and records the search in the reply's `parts` (`trackedTool`).
 * It is free (no usage row, no call from the reply's budget) and shares the per-user Conversation
 * search rate limit: over it, the search fails as a state and the reply continues.
 */
export function createSearchPastChatsTool({
  deps,
  userId,
  conversationId,
  projectId,
  ...run
}: RunToolState & {
  deps: AppDeps;
  userId: string;
  conversationId: string;
  /** The current Conversation's Project, or null for a general Conversation. */
  projectId: string | null;
}) {
  const { parts } = run;
  const failed = (toolCallId: string): SearchPastChatsOutput => {
    parts.finishPastChats(toolCallId, "error");
    return { error: searchPastChatsError };
  };
  return searchPastChatsDefinition.server(
    trackedTool(
      searchPastChatsToolName,
      run,
      {
        part: {
          start: (toolCallId, { query }: { query: string }) =>
            parts.startPastChats(toolCallId, query),
          refused: failed,
          failed: (toolCallId, caught) => {
            deps.logger.error(`Searching past chats of ${userId} failed`, caught);
            return failed(toolCallId);
          },
        },
      },
      async ({ query }, { toolCallId }): Promise<SearchPastChatsOutput> => {
        const retryAfter = await rateLimitedFor(
          deps.counters,
          deps.rateLimits.conversationSearch,
          `conversationSearch:${userId}`,
        );
        if (retryAfter !== null) return failed(toolCallId);
        const conversations = await searchPastChats(
          deps,
          { userId, conversationId, projectId },
          query,
        );
        parts.finishPastChats(toolCallId, { conversations });
        return { conversations };
      },
    ),
  );
}
