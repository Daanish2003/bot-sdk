import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import type { ToolCall } from "../../models/server/credentials/resolve";
import { tavilyService } from "../../models/shared/credentials/services";
import { WorkflowYieldedError } from "../../runner/server/workflow/engine";
import { searchErrorMessages, type WebSearchOutput, webSearchToolName } from "../shared/web-search";
import type { LoopKit } from "./loop";
import { SearchError } from "./search-client";
import { createTavilyClient } from "./tavily";

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
 * with the user's Tavily Tool credential, else the Host's, through `models`. The search runs
 * outside any transaction, and a replay returns its recorded result without searching again. The
 * Quota is checked before a search, as the assistant's is (ADR 0007), and the search is recorded in
 * the Checkpoint after it, so it is billed once. A failure is the tool's result, so the loop goes on.
 */
export function webSearchTool(
  deps: BotSdkContext,
  userId: string,
  liveRequest: LoopKit["liveRequest"],
) {
  const client = createTavilyClient(deps.fetch);
  const resolve = () => deps.models.resolveToolCall(userId, tavilyService);
  return webSearchDefinition.server(async ({ query }, context) => {
    // What the live search ran on; an attempt that resumes at the write resolves it again.
    let call: ToolCall | null | undefined;
    let usageRecorded = () => {};
    const request = liveRequest(
      webSearchToolName,
      context?.toolCallId,
      async (): Promise<WebSearchOutput> => {
        call = await resolve();
        if (!call) return { error: webSearchUnavailableError };
        if (!(await call.meter.mayRun()).ok) {
          return { error: searchErrorMessages.quota_exceeded, reason: "quota_exceeded" };
        }
        try {
          return {
            results: await client.search(query, call.credentials, {
              signal: context?.abortSignal,
            }),
          };
        } catch (caught) {
          // A stopped Turn or an expired time limit leaves the call unanswered, not failed.
          if (context?.abortSignal?.aborted || !(caught instanceof SearchError)) throw caught;
          const reason = caught.reason;
          return { error: searchErrorMessages[reason], reason };
        }
      },
      async (tx, searched) => {
        // A long result is recorded as its cut text, and is billed like any that found results.
        if (typeof searched !== "string" && !("results" in searched)) return;
        call ??= await resolve();
        if (call) usageRecorded = await call.meter.recordIn(tx);
      },
    );
    try {
      const output = await request;
      // Only once the record has committed, and never on a replay.
      usageRecorded();
      return output;
    } catch (caught) {
      // A yield is thrown once the record's Checkpoint has committed: its next attempt replays the
      // record, so it fires now or never.
      if (caught instanceof WorkflowYieldedError) usageRecorded();
      throw caught;
    }
  });
}
