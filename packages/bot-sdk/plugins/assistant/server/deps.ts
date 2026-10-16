import type { Credentials } from "../../models/server/types";
import type { SearchErrorReason, SearchResult } from "../shared/chat/web-search";

export type { SearchErrorReason, SearchResult };
// The `models` plugin's types, where the assistant's modules still read them from (spec #439).
export type {
  Credentials,
  HostEmbeddingModel,
  HostImageModel,
  HostModel,
  HostProvider,
  HostTool,
  HostTranscriptionModel,
  Quota,
  QuotaSetting,
} from "../../models/server/types";

export { ImageRefusedError } from "../../models/server/image-refused";

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

export type Limits = {
  /** Least time between two snapshots of a streaming Message. */
  snapshotIntervalMs: number;
  /** Longest a run may take before it is saved as timed out. */
  runCapMs: number;
  /** A streaming Message whose heartbeat is older than this is reaped (ADR 0006). */
  leaseMs: number;
  /** How often the reaper runs once `start()` has been called. */
  reapIntervalMs: number;
  /** How long `stop()` lets local Runs finish before it ends them. */
  drainMs: number;
  /** How long one `fetch_url` page may take, from the request to its last byte. */
  fetchTimeoutMs: number;
  /** How long one `generate_image` call may take before it fails (spec #278). */
  imageTimeoutMs: number;
};

export const defaultLimits: Limits = {
  snapshotIntervalMs: 1_000,
  runCapMs: 5 * 60_000,
  leaseMs: 30_000,
  reapIntervalMs: 30_000,
  drainMs: 250_000,
  fetchTimeoutMs: 10_000,
  imageTimeoutMs: 120_000,
};
