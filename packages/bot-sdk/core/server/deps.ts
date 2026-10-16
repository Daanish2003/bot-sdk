import type { Database } from "./db/index";
import type { BlobStore } from "./blob/store";
import type { Credentials } from "../../plugins/models/server/types";
import type { BotSdkContext } from "./plugin";

import type { CounterStore } from "./chat/counters";
import type { PubSub } from "./chat/pubsub";
import type { HostServerTool } from "./chat/host-tools";
import { createHookEmitter, type EventHooks, type HookEmitter } from "./chat/hooks";
import type { RunStreams } from "./chat/run-streams";
import { createTavilyClient } from "./chat/tavily";
import { createGuardedFetch } from "./lib/guarded-fetch";
import type { SearchErrorReason, SearchResult } from "../shared/chat/web-search";
import type { ResolvedRateLimits } from "./rate-limits";
import type { BotSdkRuntime } from "./runtime";
import type { McpServerConfig } from "./mcp/servers";
import { inProcessRunner } from "./jobs/in-process";
import type { JobRunner } from "./jobs/runner";

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
} from "../../plugins/models/server/types";

/**
 * An image the Provider's safety filter refused (spec #278). An image adapter throws it, so the
 * `generate_image` call is stored as `refused` rather than `failed`.
 */
export class ImageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefusedError";
  }
}

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

/** Everything the server entry points need from the outside world, built once at server start. */
export type AppDeps = {
  db: Database;
  /**
   * An enabled plugin's API (`BotSdkContext.plugin`): the assistant reaches the `models` plugin
   * only through `plugin("models")`.
   */
  plugin: BotSdkContext["plugin"];
  searchClient: SearchClient;
  /** The Host's own tools, offered to every reply whose Model has tools (`assistant({ tools })`). */
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
  /** The hosts the test allowance lists (`createBotSdk({ fetchAllowHosts })`); empty in production. */
  fetchAllowHosts: string[];
  /** The keyring (ADR 0010): the first secret encrypts secrets at rest, every entry decrypts. */
  keyEncryptionSecrets: string[];
  /** The remote MCP servers the Host offers (`assistant({ mcpServers })`, spec #91). */
  mcpServers: McpServerConfig[];
  /** Where file bytes are kept (`createBotSdk({ blobStore })`, ADR 0015). */
  blobStore: BlobStore;
  /** Whether the Host has banned a user (`createBotSdk({ isUserBlocked })`, spec #277). */
  isUserBlocked: (userId: string) => boolean | Promise<boolean>;
  /** Where the SDK's own failures go: the Host's `logger` (`createBotSdk({ logger })`). */
  logger: Pick<Console, "error">;
  /** Fires the Host's `hooks` after each change the SDK writes (`createBotSdk({ hooks })`). */
  hooks: HookEmitter;
  /** Whether Artifacts are on: the `create_artifact` tool, the panel and the version route (`assistant({ artifacts })`). */
  artifacts: boolean;
  /** Background jobs (ADR 0011): `assistant({ jobs })`, the in-process runner by default. */
  jobs: JobRunner;
  /** Whether Memory is on for the Host (`assistant({ memory })`, ADR 0013). */
  memory: boolean;
  /** The time as a job reads it, so the Memory job's dates are testable (ADR 0013). */
  clock: () => Date;
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

/** The production `AppDeps`. */
export function createAppDeps({
  db,
  plugin,
  keyEncryptionSecrets,
  runtime,
  rateLimits,
  tools,
  fetchAllowHosts,
  mcpServers,
  blobStore,
  isUserBlocked = () => false,
  logger = console,
  hooks,
  artifacts,
  jobs,
  memory,
}: {
  db: Database;
  plugin: AppDeps["plugin"];
  keyEncryptionSecrets: string[];
  runtime: BotSdkRuntime;
  rateLimits: ResolvedRateLimits;
  tools: HostServerTool[];
  fetchAllowHosts?: string[];
  mcpServers: McpServerConfig[];
  blobStore: BlobStore;
  isUserBlocked?: AppDeps["isUserBlocked"];
  logger?: AppDeps["logger"];
  hooks?: EventHooks;
  artifacts?: boolean;
  jobs?: JobRunner;
  memory?: boolean;
}): AppDeps {
  const deps: AppDeps = {
    logger,
    hooks: createHookEmitter(hooks, logger),
    db,
    plugin,
    blobStore,
    isUserBlocked,
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
    keyEncryptionSecrets,
    mcpServers,
    artifacts: artifacts ?? false,
    jobs: jobs ?? inProcessRunner({ db, logger, drainMs: defaultLimits.drainMs, deps: () => deps }),
    memory: memory ?? true,
    clock: () => new Date(),
  };
  return deps;
}
