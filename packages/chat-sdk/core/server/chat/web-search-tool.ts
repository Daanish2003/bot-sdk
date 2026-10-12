import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { type Credentials, type SearchClient, SearchError } from "../deps";
import type { createPartsBuilder } from "../../shared/chat/parts";
import {
  maxSearchesPerReply,
  searchErrorMessages,
  searchLimitError,
  type WebSearchOutput,
  webSearchToolName,
} from "../../shared/chat/web-search";

const webSearchDefinition = toolDefinition({
  name: webSearchToolName,
  description:
    "Search the web for current information. Returns up to 5 results with title, url and a " +
    `snippet. Use it only when the answer needs fresh or specific facts; at most ${maxSearchesPerReply} searches per reply.`,
  inputSchema: z.object({
    query: z.string().min(1).meta({ description: "What to search the web for" }),
  }),
});

/**
 * The `web_search` server tool for one reply: it searches through `searchClient` with the user's
 * Tavily Tool credential and records each search in the reply's `parts`, calling `onChange` when
 * they change. Failures become the search's error state and an `{ error }` result, so the reply
 * continues. After `maxSearchesPerReply` searches, a call gets `searchLimitError` and searches nothing.
 * `recordSearch` runs after each search that returns results, when the search is on Host credentials
 * (ADR 0007); it is awaited, so the usage row exists before the Run ends.
 */
export function createWebSearchTool({
  searchClient,
  credentials,
  parts,
  onChange,
  recordSearch,
}: {
  searchClient: SearchClient;
  credentials: Credentials;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  recordSearch?: () => Promise<void>;
}) {
  let searches = 0;
  return webSearchDefinition.server(async ({ query }, context): Promise<WebSearchOutput> => {
    // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
    const toolCallId = context?.toolCallId;
    if (!toolCallId) throw new Error("web_search was called without a tool call id");
    if (searches >= maxSearchesPerReply) return { error: searchLimitError };
    searches++;
    parts.startSearch(toolCallId, query);
    onChange();
    try {
      const results = await searchClient.search(query, credentials, {
        signal: context?.abortSignal,
      });
      parts.finishSearch(toolCallId, { results });
      await recordSearch?.();
      return { results };
    } catch (caught) {
      // A search cut off by the run ending stays running; the run closes it as cancelled.
      if (context?.abortSignal?.aborted) throw caught;
      const errorReason = caught instanceof SearchError ? caught.reason : "failed";
      parts.finishSearch(toolCallId, { errorReason });
      return { error: searchErrorMessages[errorReason], reason: errorReason };
    } finally {
      onChange();
    }
  });
}
