import type { Database } from "./db/index";
import type { AnyTextAdapter } from "@tanstack/ai";

import { adapterFor } from "./chat/adapters";
import type { CounterStore } from "./chat/counters";
import type { PubSub } from "./chat/pubsub";
import type { HostServerTool } from "./chat/host-tools";
import type { RunStreams } from "./chat/run-streams";
import { createTavilyClient } from "./chat/tavily";
import { createGuardedFetch } from "./lib/guarded-fetch";
import type { SearchErrorReason, SearchResult } from "../shared/chat/web-search";
import type { ResolvedRateLimits } from "./rate-limits";
import type { ChatRuntime } from "./runtime";
import type { ProviderId } from "../shared/credentials/services";
import type { McpServerConfig } from "./mcp/servers";

export type { SearchErrorReason, SearchResult };

/** Decrypted Provider credentials or Tool credential fields, keyed by field name. */
export type Credentials = Record<string, string>;

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
};

/**
 * A Model the Host pays for (ADR 0007). Prices are per 1M tokens, kept with the Model so a
 * third-party price snapshot never changes the Host's spending. Capability flags default to off.
 */
export type HostModel = {
  modelId: string;
  label?: string;
  images?: boolean;
  pdfs?: boolean;
  tools?: boolean;
  /** Bounds one Run's output (ADR 0007). */
  maxOutputTokens: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

/** A user's Quota on Host credentials (ADR 0007): a budget in USD over a fixed UTC day or calendar month. */
export type Quota = { budgetUsd: number; window: "day" | "month" };

/** `getQuota` as a Host passes it: a function of the user, or one fixed Quota for everyone. */
export type QuotaSetting =
  | Quota
  | null
  | ((userId: string) => Quota | null | Promise<Quota | null>);

/** The Host's own credentials for a Provider, and the Models they pay for. */
export type HostProvider = {
  provider: ProviderId;
  credentials: Credentials;
  models: HostModel[];
};

/**
 * A Tool the Host pays for (ADR 0007): the Host's Tavily key, with a fixed price per search. A
 * search on it is recorded in `chat.usage`, so it counts against the user's Quota.
 */
export type HostTool = {
  tool: "tavily";
  credentials: Credentials;
  pricePerSearchUsd: number;
};

/** Everything the server entry points need from the outside world, built once at server start. */
export type AppDeps = {
  db: Database;
  /**
   * Builds the TanStack AI text adapter for a `"provider:model"` id. `options.maxOutputTokens` is
   * set for a Host Model (ADR 0007); a user's own Model is uncapped.
   */
  adapterFor: (
    model: string,
    credentials: Credentials,
    options?: { maxOutputTokens?: number },
  ) => AnyTextAdapter;
  /** The Host credentials (`hostProviders`, ADR 0007). Never stored. */
  hostProviders: HostProvider[];
  /** The Host's Tools, such as a Tavily key for web search (`hostProviders`, ADR 0007). Never stored. */
  hostTools: HostTool[];
  /** Whether users may use their own Provider credentials (`byok`, ADR 0007). */
  byok: boolean;
  /** A user's Quota on Host credentials, `null` when unlimited (ADR 0007). */
  getQuota: (userId: string) => Promise<Quota | null>;
  searchClient: SearchClient;
  /** The Host's own tools, offered to every reply whose Model has tools (`createChat({ tools })`). */
  tools: HostServerTool[];
  /** Every Run's chunk log, which its POST response and any joiner read (ADR 0006). */
  runStreams: RunStreams;
  /** Control signals such as Stop, which a Run's owner subscribes to (ADR 0006). */
  pubsub: PubSub;
  /** Rate-limit counters, shared through the runtime (spec 87). */
  counters: CounterStore;
  /** The limits on each action, defaults and overrides merged. */
  rateLimits: ResolvedRateLimits;
  limits: Limits;
  /**
   * Set by `stop()`: once `stopping`, a new Run is refused with 503. `runs` holds this process's
   * live Runs by Message id, so `stop()` can drain them; Stop itself goes through `pubsub`.
   */
  lifecycle: { stopping: boolean; runs: Map<string, AbortController> };
  /** The SSRF-guarded `fetch` for every outside call except the user's Ollama host. */
  fetch: typeof fetch;
  /** The hosts the test allowance lists (`createChat({ fetchAllowHosts })`); empty in production. */
  fetchAllowHosts: string[];
  /**
   * `fetch` for the user's own Ollama host (its credential check and live Model list). Not
   * guarded: Ollama runs on the user's machine or LAN on purpose, and the Ollama chat adapter
   * already calls that host unguarded, so the guard would add nothing here.
   */
  ollamaFetch: typeof fetch;
  /** The keyring (ADR 0010): the first secret encrypts Provider and Tool credentials, every entry decrypts. */
  keyEncryptionSecrets: string[];
  /** The remote MCP servers the Host offers (`createChat({ mcpServers })`, spec #91). */
  mcpServers: McpServerConfig[];
};

export const defaultLimits: Limits = {
  snapshotIntervalMs: 1_000,
  runCapMs: 5 * 60_000,
  leaseMs: 30_000,
  reapIntervalMs: 30_000,
  drainMs: 250_000,
  fetchTimeoutMs: 10_000,
};

/** The production `AppDeps`. */
export function createAppDeps({
  db,
  keyEncryptionSecrets,
  runtime,
  hostProviders,
  hostTools,
  byok,
  getQuota,
  rateLimits,
  tools,
  fetchAllowHosts,
  mcpServers,
}: {
  db: Database;
  keyEncryptionSecrets: string[];
  runtime: ChatRuntime;
  hostProviders: HostProvider[];
  hostTools: HostTool[];
  byok: boolean;
  getQuota: AppDeps["getQuota"];
  rateLimits: ResolvedRateLimits;
  tools: HostServerTool[];
  fetchAllowHosts?: string[];
  mcpServers: McpServerConfig[];
}): AppDeps {
  return {
    db,
    adapterFor,
    hostProviders,
    hostTools,
    byok,
    getQuota,
    searchClient: createTavilyClient(globalThis.fetch),
    tools,
    runStreams: runtime.runStreams,
    pubsub: runtime.pubsub,
    counters: runtime.counters,
    rateLimits,
    limits: defaultLimits,
    lifecycle: { stopping: false, runs: new Map() },
    fetch: createGuardedFetch({ schemes: "http-and-https", allowHosts: fetchAllowHosts }),
    fetchAllowHosts: fetchAllowHosts ?? [],
    ollamaFetch: globalThis.fetch,
    keyEncryptionSecrets,
    mcpServers,
  };
}
