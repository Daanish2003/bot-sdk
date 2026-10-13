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

export type SearchErrorReason = "invalid_key" | "quota_exhausted" | "failed";

export const webSearchToolName = "web_search";

/** Searches one reply may make; the next call gets `searchLimitError` instead. */
export const maxSearchesPerReply = 3;

export const searchLimitError = "search limit reached";

/** What the Model reads when a search fails. */
export const searchErrorMessages: Record<SearchErrorReason, string> = {
  invalid_key: "Tavily rejected the API key",
  quota_exhausted: "Tavily's monthly quota is used up",
  failed: "The web search failed",
};

/**
 * The dictionary code a failed search is stored under (spec #256): the same text the status line
 * shows. The Model reads `searchErrorMessages` instead, so its text stays English.
 */
export const searchErrorCodes: Record<SearchErrorReason, string> = {
  invalid_key: "chat.searchFailedKey",
  quota_exhausted: "chat.searchFailedQuota",
  failed: "chat.searchFailed",
};

/** The reason a stored search code stands for; an unknown code reads as a generic failure. */
export function searchReasonOfCode(code: string | undefined): SearchErrorReason {
  const reason = (Object.keys(searchErrorCodes) as SearchErrorReason[]).find(
    (key) => searchErrorCodes[key] === code,
  );
  return reason ?? "failed";
}

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
    return {
      ...search,
      state: "error",
      results: [],
      error: { code: searchErrorCodes[output.reason ?? "failed"] },
    };
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
