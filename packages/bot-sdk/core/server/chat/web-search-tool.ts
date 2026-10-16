import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { type Credentials, type SearchClient, SearchError } from "../deps";
import type { SearchMeter } from "./meter";
import { type RunToolState, trackedTool } from "./tracked-tool";
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
 * Tavily Tool credential and records each search in the reply's `parts` (`trackedTool`). Failures
 * become the search's error state and an `{ error }` result, so the reply continues. After
 * `maxSearchesPerReply` searches, a call gets `searchLimitError`, searches nothing and records no
 * part. `meter` checks the Quota before each search: when it refuses, the search is not run and is
 * stored as `quota_exceeded` (ADR 0007). It records each search that returns results; that is
 * awaited, so the usage row exists before the Run ends.
 */
export function createWebSearchTool({
  searchClient,
  credentials,
  meter,
  ...run
}: RunToolState & {
  searchClient: SearchClient;
  credentials: Credentials;
  meter: SearchMeter;
}) {
  const { parts } = run;
  let searches = 0;
  const search = trackedTool(
    webSearchToolName,
    run,
    {
      meter,
      part: {
        start: (toolCallId, { query }: { query: string }) => parts.startSearch(toolCallId, query),
        refused: (toolCallId): WebSearchOutput => {
          parts.finishSearch(toolCallId, { errorReason: "quota_exceeded" });
          return { error: searchErrorMessages.quota_exceeded, reason: "quota_exceeded" };
        },
        failed: (toolCallId, caught): WebSearchOutput => {
          const errorReason = caught instanceof SearchError ? caught.reason : "failed";
          parts.finishSearch(toolCallId, { errorReason });
          // The Model reads English; the stored part keeps the code (spec #256).
          return { error: searchErrorMessages[errorReason], reason: errorReason };
        },
      },
    },
    async ({ query }, { toolCallId, signal }): Promise<WebSearchOutput> => {
      const results = await searchClient.search(query, credentials, { signal });
      parts.finishSearch(toolCallId, { results });
      await meter.record();
      return { results };
    },
  );
  return webSearchDefinition.server(async (input, context): Promise<WebSearchOutput> => {
    if (searches >= maxSearchesPerReply) return { error: searchLimitError };
    searches++;
    return search(input, context);
  });
}
