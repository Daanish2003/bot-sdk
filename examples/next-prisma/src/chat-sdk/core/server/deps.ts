import type { Database } from "./db/index";
import type {
  AnyEmbeddingAdapter,
  AnyImageAdapter,
  AnyTextAdapter,
  AnyTranscriptionAdapter,
} from "@tanstack/ai";
import type { BlobStore } from "./blob/store";

import {
  adapterFor,
  embeddingAdapterFor as productionEmbeddingAdapterFor,
  imageAdapterFor as productionImageAdapterFor,
} from "./chat/adapters";
import { transcriptionAdapterFor } from "./chat/transcription";
import type { CounterStore } from "./chat/counters";
import type { PubSub } from "./chat/pubsub";
import type { HostServerTool } from "./chat/host-tools";
import { createHookEmitter, type ChatHooks, type HookEmitter } from "./chat/hooks";
import type { RunStreams } from "./chat/run-streams";
import { createTavilyClient } from "./chat/tavily";
import { createGuardedFetch } from "./lib/guarded-fetch";
import type { SearchErrorReason, SearchResult } from "../shared/chat/web-search";
import type { ResolvedRateLimits } from "./rate-limits";
import type { ChatRuntime } from "./runtime";
import type { ProviderId } from "../shared/credentials/services";
import type { McpServerConfig } from "./mcp/servers";
import { inProcessRunner } from "./jobs/in-process";
import type { JobRunner } from "./jobs/runner";

export type { SearchErrorReason, SearchResult };

/** Decrypted Provider credentials or Tool credential fields, keyed by field name. */
export type Credentials = Record<string, string>;

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

/**
 * A transcription Model the Host pays for, for dictation (spec #249). Its price is per minute of
 * audio, since the Providers' transcription APIs report no cost.
 */
export type HostTranscriptionModel = { model: string; pricePerMinuteUsd: number };

/**
 * An embedding Model the Host pays for (ADR 0014): its price per 1M tokens. Its id is one of the
 * OpenAI or Gemini embedding Models the SDK serves.
 */
export type HostEmbeddingModel = { model: string; pricePerMillionTokensUsd: number };

/** The Host's own credentials for a Provider, and the Models they pay for. */
export type HostProvider = {
  provider: ProviderId;
  credentials: Credentials;
  models: HostModel[];
  /** The Host's Image Models of this Provider (spec #278). */
  imageModels?: HostImageModel[];
  /** Transcription Models for dictation, on OpenAI, Groq or Grok only (spec #249). */
  transcriptionModels?: HostTranscriptionModel[];
  /** Embedding Models for Knowledge, on OpenAI or Gemini only (ADR 0014). */
  embeddingModels?: HostEmbeddingModel[];
};

/**
 * A Host Image Model (spec #278): the Model with its size and quality pinned, and what one image
 * costs. `pricePerImageUsd` is required, as `maxOutputTokens` is for a chat Model. The token prices
 * are for Providers that report tokens (ADR 0007).
 */
export type HostImageModel = {
  modelId: string;
  size: string;
  quality: string;
  pricePerImageUsd: number;
  imageInputPerMTok?: number;
  imageOutputPerMTok?: number;
  textInputPerMTok?: number;
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
   * Builds the TanStack AI image adapter for an Image Model (spec #278), from the credentials it
   * runs on, or `undefined` when no adapter serves that Model (the reply then offers no image tool).
   * Injected so tests and CI can pass a fake.
   */
  imageAdapterFor: (model: string, credentials: Credentials) => AnyImageAdapter | undefined;
  /**
   * Builds the TanStack AI text adapter for a `"provider:model"` id. `options.maxOutputTokens` is
   * set for a Host Model (ADR 0007); a user's own Model is uncapped.
   */
  adapterFor: (
    model: string,
    credentials: Credentials,
    options?: { maxOutputTokens?: number },
  ) => AnyTextAdapter;
  /**
   * Builds the TanStack AI transcription adapter for a `"provider:model"` id (spec #249), from the
   * user's own key for that Provider.
   */
  transcriptionAdapterFor: (model: string, credentials: Credentials) => AnyTranscriptionAdapter;
  /**
   * Builds the TanStack AI embedding adapter for an embedding Model's `(model, credentials)` (ADR
   * 0014). Injected so tests and CI can pass a fake.
   */
  embeddingAdapterFor: (model: string, credentials: Credentials) => AnyEmbeddingAdapter;
  /** The Host credentials (`hostProviders`, ADR 0007). Never stored. */
  hostProviders: HostProvider[];
  /** The Host's Tools, such as a Tavily key for web search (`hostProviders`, ADR 0007). Never stored. */
  hostTools: HostTool[];
  /** Whether users may use their own Provider credentials (`byok`, ADR 0007). */
  byok: boolean;
  /** The Host's default Background Model, a Host Model's id, or `null` (`defaultBackgroundModel`). */
  defaultBackgroundModel: string | null;
  /** The Host's default Image Model, a Host Image Model's id, or `null` (`defaultImageModel`). */
  defaultImageModel: string | null;
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
  /** Where file bytes are kept (`createChat({ blobStore })`, ADR 0015). */
  blobStore: BlobStore;
  /** Whether the Host has banned a user (`createChat({ isUserBlocked })`, spec #277). */
  isUserBlocked: (userId: string) => boolean | Promise<boolean>;
  /** Where the SDK's own failures go: the Host's `logger` (`createChat({ logger })`). */
  logger: Pick<Console, "error">;
  /** Fires the Host's `hooks` after each change the SDK writes (`createChat({ hooks })`). */
  hooks: HookEmitter;
  /** Whether Artifacts are on: the `create_artifact` tool, the panel and the version route (`createChat({ artifacts })`). */
  artifacts: boolean;
  /** Background jobs (ADR 0011): `createChat({ jobs })`, the in-process runner by default. */
  jobs: JobRunner;
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
  imageAdapterFor,
  keyEncryptionSecrets,
  runtime,
  hostProviders,
  hostTools,
  byok,
  defaultBackgroundModel,
  defaultImageModel,
  getQuota,
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
}: {
  db: Database;
  /** The image adapter factory; the production one is `imageAdapterFor` in `chat/adapters.ts`. */
  imageAdapterFor?: AppDeps["imageAdapterFor"];
  keyEncryptionSecrets: string[];
  runtime: ChatRuntime;
  hostProviders: HostProvider[];
  hostTools: HostTool[];
  byok: boolean;
  defaultBackgroundModel?: string;
  defaultImageModel?: string;
  getQuota: AppDeps["getQuota"];
  rateLimits: ResolvedRateLimits;
  tools: HostServerTool[];
  fetchAllowHosts?: string[];
  mcpServers: McpServerConfig[];
  blobStore: BlobStore;
  isUserBlocked?: AppDeps["isUserBlocked"];
  logger?: AppDeps["logger"];
  hooks?: ChatHooks;
  artifacts?: boolean;
  jobs?: JobRunner;
}): AppDeps {
  return {
    logger,
    hooks: createHookEmitter(hooks, logger),
    db,
    blobStore,
    isUserBlocked,
    adapterFor,
    imageAdapterFor: imageAdapterFor ?? productionImageAdapterFor,
    transcriptionAdapterFor,
    embeddingAdapterFor: productionEmbeddingAdapterFor,
    hostProviders,
    hostTools,
    byok,
    defaultBackgroundModel: defaultBackgroundModel ?? null,
    defaultImageModel: defaultImageModel ?? null,
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
    artifacts: artifacts ?? false,
    jobs: jobs ?? inProcessRunner({ db, logger, drainMs: defaultLimits.drainMs }),
  };
}
