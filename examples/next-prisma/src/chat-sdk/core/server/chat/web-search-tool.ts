import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { type Credentials, type SearchClient, SearchError } from "../deps";
import type { createPartsBuilder } from "../../shared/chat/parts";
import type { SearchMeter } from "./meter";
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
 * `meter` checks the Quota before each search: when it refuses, the search is not run and is stored
 * as `quota_exceeded` (ADR 0007). It records each search that returns results; that is awaited, so
 * the usage row exists before the Run ends.
 */
export function createWebSearchTool({
  searchClient,
  credentials,
  meter,
  parts,
  onChange,
}: {
  searchClient: SearchClient;
  credentials: Credentials;
  meter: SearchMeter;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
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
      if (!(await meter.mayRun()).ok) {
        parts.finishSearch(toolCallId, { errorReason: "quota_exceeded" });
        return { error: searchErrorMessages.quota_exceeded, reason: "quota_exceeded" };
      }
      const results = await searchClient.search(query, credentials, {
        signal: context?.abortSignal,
      });
      parts.finishSearch(toolCallId, { results });
      await meter.record();
      return { results };
    } catch (caught) {
      // A search cut off by the run ending stays running; the run closes it as cancelled.
      if (context?.abortSignal?.aborted) throw caught;
      const errorReason = caught instanceof SearchError ? caught.reason : "failed";
      parts.finishSearch(toolCallId, { errorReason });
      // The Model reads English; the stored part keeps the code (spec #256).
      return { error: searchErrorMessages[errorReason], reason: errorReason };
    } finally {
      onChange();
    }
  });
}
