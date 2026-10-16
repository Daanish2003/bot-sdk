import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import { defaultRateLimits } from "../../../core/server/rate-limits";
import {
  adapterFor,
  embeddingAdapterFor as productionEmbeddingAdapterFor,
  imageAdapterFor as productionImageAdapterFor,
  imageRequestFor,
} from "./adapters";
import { listAvailableModels, resolveModel } from "./available-models";
import {
  resolveModelCall,
  resolvePayer,
  resolveToolCall,
  type ModelCall,
  type Payer,
  type ToolCall,
} from "./credentials/resolve";
import {
  countUnreadableCredentials,
  loadCredentials,
  rotateCredentialKeys,
} from "./credentials/store";
import { modelsUserDelete } from "./delete-user";
import {
  defaultEmbeddingModel,
  embeddingModelIds,
  embeddingModelsProblem,
  embedTexts,
  resolveEmbeddingModel,
  type ResolvedEmbeddingModel,
} from "./embedding-models";
import { resolveImageModel, type ResolvedImageModel } from "./image-models";
import { quotaLookup, quotaState, readQuota, type QuotaState } from "./quota";
import { modelsPluginRouter } from "./routers/index";
import { bindModelsDeps } from "./state";
import {
  transcribeRecording,
  transcriptionAdapterFor,
  transcriptionProviders,
} from "./transcription";
import type { Credentials, HostProvider, HostTool, ModelsDeps, QuotaSetting } from "./types";
import { messageUsage, usageByDay, usageTotals, type UsageByDay, type UsageTotal } from "./usage";

export type ModelsOptions = {
  /**
   * The Host's own credentials (ADR 0007). A Provider entry carries its Models; a Tool entry (`tool:
   * "tavily"`) carries its price per search. Never stored.
   */
  hostProviders?: Array<HostProvider | HostTool>;
  /** Whether users may use their own Provider credentials. Defaults to `true` (ADR 0007). */
  byok?: boolean;
  /**
   * The Host's default Background Model: a `"provider:model"` id of one of the `hostProviders`
   * Models. Titles use it when a user picks none; `start()` refuses any other id.
   */
  defaultBackgroundModel?: string;
  /**
   * The Host's default Image Model: a `"provider:model"` id of one of the `hostProviders`'s Image
   * Models. Image generation uses it when a user picks none; with none, there are no Host images.
   * `start()` refuses any other id.
   */
  defaultImageModel?: string;
  /**
   * A user's Quota on Host credentials, or one fixed Quota for everyone; `null` or unset is
   * unlimited (ADR 0007).
   */
  getQuota?: QuotaSetting;
  /**
   * The image adapter for an Image Model's `(model, credentials)`, or `undefined` for none. Defaults
   * to the production adapters, which are not wired yet (spec #278, ticket #311), so no Image Model
   * offers the image tool until they are. A Host passes a fake here to try the tool.
   */
  imageAdapterFor?: ModelsDeps["imageAdapterFor"];
  /**
   * The embedding adapter for an embedding Model's `(model, credentials)`. Defaults to the
   * production adapters (OpenAI and Gemini). A Host passes a fake here to run Knowledge without a
   * paid call (spec #357, ticket #370).
   */
  embeddingAdapterFor?: ModelsDeps["embeddingAdapterFor"];
};

/**
 * The `models` plugin's API (`sdk.plugin("models")`): who pays for a call and with which
 * credentials, the Models a user can pick, metering and the Quota.
 */
export type ModelsApi = {
  resolveModelCall: (userId: string, id: string) => Promise<ModelCall | null>;
  resolveToolCall: (userId: string, tool: HostTool["tool"]) => Promise<ToolCall | null>;
  resolvePayer: <Offer>(
    userId: string,
    services: readonly string[],
    hostOffer: () => Offer | null | undefined,
  ) => Promise<Payer<Offer> | null>;
  resolveModel: (userId: string, id: string) => ReturnType<typeof resolveModel>;
  listAvailableModels: (userId: string) => ReturnType<typeof listAvailableModels>;
  resolveImageModel: (userId: string, id: string) => Promise<ResolvedImageModel | undefined>;
  resolveEmbeddingModel: (userId: string, id: string) => Promise<ResolvedEmbeddingModel | null>;
  /** The embedding Model a user's Knowledge and Memory use by default (ADR 0014). */
  defaultEmbeddingModel: (userId: string) => Promise<ResolvedEmbeddingModel | null>;
  /** Every embedding Model the SDK knows, as `"provider:model"`. */
  embeddingModelIds: () => string[];
  embedTexts: (args: Parameters<typeof embedTexts>[1]) => Promise<number[][]>;
  transcribeRecording: (
    userId: string,
    recording: Parameters<typeof transcribeRecording>[2],
  ) => Promise<string>;
  readQuota: (userId: string) => ReturnType<typeof readQuota>;
  messageUsage: typeof messageUsage;
  loadCredentials: (userId: string, service: string) => Promise<Credentials | null>;
  /** The text adapter for a `"provider:model"` id (`ModelsDeps.adapterFor`). */
  adapterFor: ModelsDeps["adapterFor"];
  /** The image adapter for an Image Model, or `undefined` (`ModelsDeps.imageAdapterFor`). */
  imageAdapterFor: ModelsDeps["imageAdapterFor"];
  /** The size and provider options one image call sends (spec #278). */
  imageRequestFor: typeof imageRequestFor;
  /** Whether users may use their own Provider credentials (`byok`, ADR 0007). */
  readonly byok: boolean;
  /** The Host's default Background Model, or `null`. */
  readonly defaultBackgroundModel: string | null;
  /** The Host's default Image Model, or `null`. */
  readonly defaultImageModel: string | null;
  // `usageTotals`, `usage` and `quota` are server-only reads for the Host's Admin views (spec #277).
  // No HTTP route: the Host decides who may call them. They never return Conversation content.
  /** Every user's calls on Host credentials created in `[since, until)`. */
  usageTotals: (range: { since: Date; until: Date }) => Promise<UsageTotal[]>;
  /** One user's calls per UTC day and Model in `[since, until)` (spec #277). */
  usage: (args: { userId: string; since: Date; until: Date }) => Promise<UsageByDay[]>;
  /** A user's budget and spend in micros, with its window's reset time; `null` when unlimited. */
  quota: (userId: string) => Promise<QuotaState | null>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    models: ModelsApi;
  }
}

/** The rate-limit rules the `models` plugin declares, and their defaults. */
const modelsRateLimits = {
  credentialSave: defaultRateLimits.credentialSave,
  transcription: defaultRateLimits.transcription,
};

export type ModelsRule = keyof typeof modelsRateLimits;

export type ModelsPlugin = BotSdkPlugin<"models", ModelsRule, "onUsage">;

/**
 * The `models` plugin (ADR 0020): Provider and Tool credentials, who pays for each call, the
 * Models a user can pick, usage metering and the Quota.
 */
export function models(options: ModelsOptions = {}): ModelsPlugin {
  return modelsPlugin((sdk) => productionDeps(sdk, options), {
    start: async (sdk, deps) => {
      checkStart(options);
      // Unreadable rows are reported, never a reason to refuse to boot (ADR 0010).
      const unreadable = await countUnreadableCredentials(deps);
      if (unreadable.unknownKey + unreadable.corrupt > 0) {
        sdk.logger.error("Stored credentials can't be read", unreadable);
      }
    },
  });
}

/**
 * The `models` plugin over a ready `ModelsDeps`: the test seam (`createTestSdk`). Nothing is
 * checked at `start()`.
 */
export function modelsOver(deps: ModelsDeps): ModelsPlugin {
  return modelsPlugin(() => deps, {});
}

function modelsPlugin(
  buildDeps: (sdk: BotSdkContext) => ModelsDeps,
  { start }: { start?: (sdk: BotSdkContext, deps: ModelsDeps) => Promise<void> },
): ModelsPlugin {
  // One `ModelsDeps` per instance, built by `init`.
  const states = new WeakMap<BotSdkContext, ModelsDeps>();
  const ready = (sdk: BotSdkContext) => {
    let deps = states.get(sdk);
    if (!deps) {
      deps = buildDeps(sdk);
      states.set(sdk, deps);
    }
    return deps;
  };
  return {
    id: "models",
    router: modelsPluginRouter,
    rateLimits: modelsRateLimits,
    init: (sdk) => {
      const deps = ready(sdk);
      const api = modelsApi(deps);
      bindModelsDeps(api, deps);
      return { api };
    },
    start: async (sdk) => {
      await start?.(sdk, ready(sdk));
    },
    deleteUser: modelsUserDelete,
    rotateKeys: async (sdk) => {
      const deps = ready(sdk);
      const { reencrypted, unreadable } = await rotateCredentialKeys(deps);
      const unreadableCount = unreadable.unknownKey + unreadable.corrupt;
      if (unreadableCount > 0) {
        deps.logger.error("Stored credentials can't be read; left in place", unreadable);
      }
      return { reencrypted, unreadable: unreadableCount };
    },
  };
}

/** The production `ModelsDeps`, over the core context. Exported for its test. */
export function productionDeps(sdk: BotSdkContext, options: ModelsOptions): ModelsDeps {
  return {
    db: sdk.db,
    keyEncryptionSecrets: sdk.keyring,
    hooks: sdk.events,
    logger: sdk.logger,
    fetch: sdk.fetch,
    ollamaFetch: globalThis.fetch,
    adapterFor,
    imageAdapterFor: options.imageAdapterFor ?? productionImageAdapterFor,
    transcriptionAdapterFor,
    embeddingAdapterFor: options.embeddingAdapterFor ?? productionEmbeddingAdapterFor,
    hostProviders: (options.hostProviders ?? []).filter(isHostProvider),
    hostTools: (options.hostProviders ?? []).filter(isHostTool),
    byok: options.byok ?? true,
    defaultBackgroundModel: options.defaultBackgroundModel ?? null,
    defaultImageModel: options.defaultImageModel ?? null,
    getQuota: quotaLookup(options.getQuota),
  };
}

/** The API bound to `deps`. The values read `deps` on each access, so they follow it. */
function modelsApi(deps: ModelsDeps): ModelsApi {
  return {
    resolveModelCall: (userId, id) => resolveModelCall(deps, userId, id),
    resolveToolCall: (userId, tool) => resolveToolCall(deps, userId, tool),
    resolvePayer: (userId, services, hostOffer) => resolvePayer(deps, userId, services, hostOffer),
    resolveModel: (userId, id) => resolveModel(deps, userId, id),
    listAvailableModels: (userId) => listAvailableModels(deps, userId),
    resolveImageModel: (userId, id) => resolveImageModel(deps, userId, id),
    resolveEmbeddingModel: (userId, id) => resolveEmbeddingModel(deps, userId, id),
    defaultEmbeddingModel: (userId) => defaultEmbeddingModel(deps, userId),
    embeddingModelIds,
    embedTexts: (args) => embedTexts(deps, args),
    transcribeRecording: (userId, recording) => transcribeRecording(deps, userId, recording),
    readQuota: (userId) => readQuota(deps, userId),
    messageUsage,
    loadCredentials: (userId, service) => loadCredentials(deps, userId, service),
    adapterFor: (model, credentials, adapterOptions) =>
      deps.adapterFor(model, credentials, adapterOptions),
    imageAdapterFor: (model, credentials) => deps.imageAdapterFor(model, credentials),
    imageRequestFor,
    get byok() {
      return deps.byok;
    },
    get defaultBackgroundModel() {
      return deps.defaultBackgroundModel;
    },
    get defaultImageModel() {
      return deps.defaultImageModel;
    },
    usageTotals: (range) => usageTotals(deps, range),
    usage: ({ userId, since, until }) => usageByDay(deps, userId, { since, until }),
    quota: (userId) => quotaState(deps, userId),
  };
}

/** The configuration checks `start()` makes before anything starts. */
function checkStart(options: ModelsOptions) {
  if (options.byok === false && !options.hostProviders?.length) {
    throw new Error("Configure hostProviders, byok, or both: with neither, no one can chat");
  }
  for (const entry of options.hostProviders ?? []) {
    if (isHostProvider(entry) && entry.transcriptionModels?.length) {
      if (!transcriptionProviders.includes(entry.provider)) {
        throw new Error(
          `hostProviders: ${entry.provider} has no transcription adapter, so it can't list transcriptionModels`,
        );
      }
    }
  }
  const hostProviders = (options.hostProviders ?? []).filter(isHostProvider);
  for (const entry of hostProviders) {
    const problem = embeddingModelsProblem(entry);
    if (problem) throw new Error(problem);
  }
  const defaultBackground = options.defaultBackgroundModel;
  if (
    defaultBackground !== undefined &&
    !hostProviders.some(({ provider, models }) =>
      models.some((model) => `${provider}:${model.modelId}` === defaultBackground),
    )
  ) {
    throw new Error(
      `defaultBackgroundModel "${defaultBackground}" is not one of the hostProviders' Models`,
    );
  }
  for (const { provider, imageModels = [] } of hostProviders) {
    for (const model of imageModels) {
      // A Host Image Model is priced per image; without a price its spend isn't recorded.
      if (!(model.pricePerImageUsd >= 0)) {
        throw new Error(`Host Image Model "${provider}:${model.modelId}" needs a pricePerImageUsd`);
      }
    }
  }
  const defaultImage = options.defaultImageModel;
  if (
    defaultImage !== undefined &&
    !hostProviders.some(({ provider, imageModels = [] }) =>
      imageModels.some((model) => `${provider}:${model.modelId}` === defaultImage),
    )
  ) {
    throw new Error(
      `defaultImageModel "${defaultImage}" is not one of the hostProviders' Image Models`,
    );
  }
}

const isHostTool = (entry: HostProvider | HostTool): entry is HostTool => "tool" in entry;
const isHostProvider = (entry: HostProvider | HostTool): entry is HostProvider =>
  !isHostTool(entry);
