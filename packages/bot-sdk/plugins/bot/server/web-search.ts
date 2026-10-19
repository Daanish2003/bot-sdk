import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { SearchError } from "../../assistant/server/deps";
import { createTavilyClient } from "../../assistant/server/chat/tavily";
import {
  searchErrorMessages,
  type WebSearchOutput,
  webSearchToolName,
} from "../../assistant/shared/chat/web-search";
import { tavilyService } from "../../models/shared/credentials/services";
import type { LoopKit } from "./loop";

/** What `web_search` returns with neither a Tool credential nor a Host key (#592). */
export const webSearchUnavailableError =
  "Web search isn't set up. Add a Tavily key in Settings, or ask the user.";

const webSearchDefinition = toolDefinition({
  name: webSearchToolName,
  description:
    "Search the web for current information. Returns up to 5 results with title, url and a " +
    "snippet. Use it when the answer needs fresh or specific facts.",
  inputSchema: z.object({
    query: z.string().min(1).meta({ description: "What to search the web for" }),
  }),
});

/**
 * The `web_search` tool of a Turn's or a Helper's loop. It is the `bot` plugin's own: it searches
 * with the user's Tavily Tool credential, else the Host's, through `models`. One search is one
 * activity, so a replay returns its recorded result without searching again. The Quota is checked
 * before a search and the search recorded after it, as the assistant's is (ADR 0007). A failure is
 * the tool's result, so the loop goes on.
 */
export function webSearchTool(
  deps: BotSdkContext,
  userId: string,
  liveActivity: LoopKit["liveActivity"],
) {
  const client = createTavilyClient(deps.fetch);
  return webSearchDefinition.server(({ query }, context) =>
    liveActivity(webSearchToolName, context?.toolCallId, async (): Promise<WebSearchOutput> => {
      const call = await deps.plugin("models").resolveToolCall(userId, tavilyService);
      if (!call) return { error: webSearchUnavailableError };
      if (!(await call.meter.mayRun()).ok) {
        return { error: searchErrorMessages.quota_exceeded, reason: "quota_exceeded" };
      }
      try {
        const results = await client.search(query, call.credentials, {
          signal: context?.abortSignal,
        });
        await call.meter.record();
        return { results };
      } catch (caught) {
        // A stopped Turn or an expired time limit leaves the call unanswered, not failed.
        if (context?.abortSignal?.aborted) throw caught;
        const reason = caught instanceof SearchError ? caught.reason : "failed";
        return { error: searchErrorMessages[reason], reason };
      }
    }),
  );
}
