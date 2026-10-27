import type { Credentials } from "../../models/internal";
import type { SearchErrorReason, SearchResult } from "../shared/web-search";

export class SearchError extends Error {
  readonly reason: SearchErrorReason;

  constructor(reason: SearchErrorReason, message: string = `Web search failed: ${reason}`) {
    super(message);
    this.name = "SearchError";
    this.reason = reason;
  }
}

/** Web search backend for the `web_search` tool. Failures throw a `SearchError`. */
export type SearchClient = {
  search: (
    query: string,
    credentials: Credentials,
    options?: { signal?: AbortSignal },
  ) => Promise<SearchResult[]>;
};
