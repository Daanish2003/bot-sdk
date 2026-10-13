import type { WebSearchPart } from "../message-parts";
import type { MessagePart } from "@tanstack/ai";

/**
 * The `web_search` tool's contract, shared by the server tool, the parts boundary and the web
 * app. No server code: safe to import into the browser.
 */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

/**
 * `quota_exceeded` is the Host's Quota refusing the search before it runs (ADR 0007), kept apart
 * from `quota_exhausted`, which is Tavily's own monthly quota.
 */
export type SearchErrorReason = "invalid_key" | "quota_exhausted" | "quota_exceeded" | "failed";

export const webSearchToolName = "web_search";

/** Searches one reply may make; the next call gets `searchLimitError` instead. */
export const maxSearchesPerReply = 3;

export const searchLimitError = "search limit reached";

/** What the Model reads when a search fails. */
export const searchErrorMessages: Record<SearchErrorReason, string> = {
  invalid_key: "Tavily rejected the API key",
  quota_exhausted: "Tavily's monthly quota is used up",
  quota_exceeded: "Over this window's Quota, so the search wasn't run",
  failed: "The web search failed",
};

/**
 * The `web_search` tool result the Model sees, and `useChat` streams. A failed search carries
 * its `reason` for the web app; a call over the limit has none (it never searched).
 */
export type WebSearchOutput =
  | { results: SearchResult[] }
  | { error: string; reason?: SearchErrorReason };

/**
 * The search a `useChat` part shows, whether it streamed in or came from `toUIParts`; `null`
 * for any other part, a call whose query hasn't streamed in yet, and a call over the per-reply
 * limit.
 */
export function webSearchOf(part: MessagePart): WebSearchPart | null {
  if (part.type !== "tool-call" || part.name !== webSearchToolName) return null;
  const output = part.output as Partial<{
    results: SearchResult[];
    error: string;
    reason: SearchErrorReason;
  }> | null;
  if (output?.error === searchLimitError) return null;
  const query = queryOf(part);
  if (!query && !output) return null;

  const search = { type: "web_search", toolCallId: part.id, query } as const;
  if (Array.isArray(output?.results)) {
    return { ...search, state: "done", results: output.results };
  }
  if (typeof output?.error === "string") {
    return { ...search, state: "error", results: [], errorReason: output.reason ?? "failed" };
  }
  // A call that ended without a result was cancelled.
  return { ...search, state: part.state === "error" ? "cancelled" : "running", results: [] };
}

function queryOf(part: Extract<MessagePart, { type: "tool-call" }>): string {
  const input = (part.input ?? safeParse(part.arguments)) as { query?: unknown } | undefined;
  return typeof input?.query === "string" ? input.query : "";
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
