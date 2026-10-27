import type { Credentials } from "@botsdk/bot/models/internal";
import type { SearchErrorReason, SearchResult } from "@botsdk/bot/bot/shared/web-search";
import { type SearchClient, SearchError } from "@botsdk/bot/bot/agent-loop";

export type FakeSearchClient = SearchClient & {
  /** Every search made, in order. */
  calls: Array<{ query: string; credentials: Credentials }>;
};

/** A search client that returns `results` for every query, or throws a `SearchError` with `error`. */
export function createFakeSearchClient({
  results = [],
  error,
}: { results?: SearchResult[]; error?: SearchErrorReason } = {}): FakeSearchClient {
  const calls: FakeSearchClient["calls"] = [];
  return {
    calls,
    search: async (query, credentials) => {
      calls.push({ query, credentials });
      if (error) throw new SearchError(error);
      return results;
    },
  };
}
