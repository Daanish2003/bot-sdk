import { z } from "zod";

import { type SearchClient, SearchError, type SearchErrorReason } from "../deps";

/** How many results one search keeps. */
export const maxSearchResults = 5;

const tavilyResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      published_date: z.string().nullish(),
    }),
  ),
});

/**
 * Tavily's `/search` (basic depth) through `fetch`, with the user's Tool credential. HTTP
 * statuses become a `SearchError` reason: 401/403 a rejected key, 432/433 a used-up plan or
 * pay-as-you-go limit, anything else (a network failure, no answer within `timeoutMs`) `failed`.
 */
export function createTavilyClient(
  fetch: typeof globalThis.fetch,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): SearchClient {
  return {
    async search(query, credentials, options) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.apiKey ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query, search_depth: "basic", max_results: maxSearchResults }),
          signal,
        });
      } catch (caught) {
        throw new SearchError("failed", `Couldn't reach Tavily: ${String(caught)}`);
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new SearchError(reasonOf(response.status), `Tavily answered HTTP ${response.status}`);
      }
      const parsed = tavilyResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new SearchError("failed", "Tavily sent an unexpected response");

      return parsed.data.results.slice(0, maxSearchResults).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        ...(result.published_date ? { publishedDate: result.published_date } : {}),
      }));
    },
  };
}

function reasonOf(status: number): SearchErrorReason {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 432 || status === 433) return "quota_exhausted";
  return "failed";
}
