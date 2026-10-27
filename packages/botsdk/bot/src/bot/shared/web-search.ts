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
 * The dictionary code a failed search is stored under (spec #256): the same text the status line
 * shows. The Model reads `searchErrorMessages` instead, so its text stays English.
 */
export const searchErrorCodes: Record<SearchErrorReason, string> = {
  invalid_key: "chat.searchFailedKey",
  quota_exhausted: "chat.searchFailedQuota",
  quota_exceeded: "chat.searchNotRunQuota",
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
