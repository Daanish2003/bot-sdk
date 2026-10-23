import type { AnyImageAdapter, AnyTextAdapter } from "@tanstack/ai";

import type { HookEmitter } from "../../../core/server/chat/hooks";
import type { Database } from "../../../core/server/db/index";
import type { ProviderId } from "../shared/credentials/services";

/** Decrypted Provider credentials or Tool credential fields, keyed by field name. */
export type Credentials = Record<string, string>;

/**
 * What the Host's `linkedCredentials` hook returns for a user and a service (ADR 0023): the linked
 * Provider credentials (a ChatGPT plan's access token as OpenAI's `apiKey`), nothing, or
 * `"needs-reconnect"` when the link is broken.
 */
export type LinkedCredentials = Credentials | "needs-reconnect" | null | undefined;

/** The Host's hook for linked Provider credentials (ADR 0023). Asked only for OpenAI today. */
export type LinkedCredentialsHook = (
  userId: string,
  service: ProviderId,
) => LinkedCredentials | Promise<LinkedCredentials>;

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
  /** The price of input read from the prompt cache. Unset, it is `inputUsdPerMillion`. */
  cacheReadUsdPerMillion?: number;
  /** The price of input written to the prompt cache. Unset, it is `inputUsdPerMillion`. */
  cacheWriteUsdPerMillion?: number;
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
  /** The Host's Image Models of this Provider (spec #278). */
  imageModels?: HostImageModel[];
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

/**
 * A source of the user's recent Model, which another plugin registers: the Model the user last
 * chose through it as a `"provider:model"` id, or nothing. The default Model of `models.list` is
 * the first source's that the user can use.
 */
export type RecentModelSource = (userId: string) => Promise<string | null | undefined>;

/** What the `models` plugin's modules run on: the core's parts they use, and the plugin's options. */
export type ModelsDeps = {
  db: Database;
  /** The core's keyring (ADR 0010): the first secret encrypts credentials, every entry decrypts. */
  keyEncryptionSecrets: string[];
  /** The core's emitter, which fires `onUsage`. */
  hooks: HookEmitter;
  logger: Pick<Console, "error">;
  /** The core's SSRF-guarded `fetch`. */
  fetch: typeof fetch;
  /**
   * `fetch` for the user's own Ollama host (its credential check and live Model list). Not
   * guarded: Ollama runs on the user's machine or LAN on purpose, and the Ollama chat adapter
   * already calls that host unguarded, so the guard would add nothing here.
   */
  ollamaFetch: typeof fetch;
  /**
   * Builds the TanStack AI text adapter for a `"provider:model"` id. `options.maxOutputTokens` is
   * set for a Host Model (ADR 0007); a user's own Model is uncapped.
   */
  adapterFor: (
    model: string,
    credentials: Credentials,
    options?: {
      maxOutputTokens?: number;
      /** The credentials are a linked ChatGPT plan's: the call goes the plan's way (ADR 0023). */
      linked?: boolean;
    },
  ) => AnyTextAdapter;
  /**
   * Builds the TanStack AI image adapter for an Image Model (spec #278), from the credentials it
   * runs on, or `undefined` when no adapter serves that Model (the reply then offers no image tool).
   * Injected so tests and CI can pass a fake.
   */
  imageAdapterFor: (model: string, credentials: Credentials) => AnyImageAdapter | undefined;
  /** The Host credentials (`hostProviders`, ADR 0007). Never stored. */
  hostProviders: HostProvider[];
  /** The Host's Tools, such as a Tavily key for web search (`hostProviders`, ADR 0007). Never stored. */
  hostTools: HostTool[];
  /** Whether users may use their own Provider credentials (`byok`, ADR 0007). */
  byok: boolean;
  /** The Host's hook for linked Provider credentials, or none (ADR 0023). */
  linkedCredentials?: LinkedCredentialsHook;
  /** The Host's default Image Model, a Host Image Model's id, or `null` (`defaultImageModel`). */
  defaultImageModel: string | null;
  /** The recent-Model sources other plugins registered, in order (`addRecentModelSource`). */
  recentModelSources: RecentModelSource[];
  /** A user's Quota on Host credentials, `null` when unlimited (ADR 0007). */
  getQuota: (userId: string) => Promise<Quota | null>;
};
