import {
  type Credentials,
  type SearchClient,
  SearchError,
  type SearchErrorReason,
  type SearchResult,
} from "../../core/server/deps";

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
