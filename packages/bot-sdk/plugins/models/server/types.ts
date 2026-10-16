import type {
  AnyEmbeddingAdapter,
  AnyImageAdapter,
  AnyTextAdapter,
  AnyTranscriptionAdapter,
} from "@tanstack/ai";

import type { HookEmitter } from "../../../core/server/chat/hooks";
import type { Database } from "../../../core/server/db/index";
import type { ProviderId } from "../../../core/shared/credentials/services";

/** Decrypted Provider credentials or Tool credential fields, keyed by field name. */
export type Credentials = Record<string, string>;

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
    options?: { maxOutputTokens?: number },
  ) => AnyTextAdapter;
  /**
   * Builds the TanStack AI image adapter for an Image Model (spec #278), from the credentials it
   * runs on, or `undefined` when no adapter serves that Model (the reply then offers no image tool).
   * Injected so tests and CI can pass a fake.
   */
  imageAdapterFor: (model: string, credentials: Credentials) => AnyImageAdapter | undefined;
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
};
