import type { AnyTextAdapter } from "@tanstack/ai";

import type { BotSdkContext, BotSdkPlugin } from "../plugin";
import { defaultRateLimits } from "../rate-limits";
import { adaptersOf, imageRequestFor } from "./adapters";
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
  loadImageModelSetting,
  resolveUserImageModel,
  saveImageModelSetting,
} from "./image-model-setting";
import { hostImageModelList, resolveImageModel, type ResolvedImageModel } from "./image-models";
import { quotaLookup, quotaState, readQuota, type QuotaState } from "./quota";
import { modelsDomain, type ModelsDomain } from "./models-domain";
import { modelsPluginRouter } from "./routers/index";
import { bindModelsDeps } from "./state";
import { freeModelMeter, type ModelMeter } from "./meter";
import { reconnectChatgptAdapter } from "./chatgpt-plan";
import type {
  Credentials,
  HostProvider,
  HostTool,
  LinkedCredentialsHook,
  ModelProviders,
  ModelsDeps,
  QuotaSetting,
  RecentModelSource,
} from "./types";
import { messageUsage, usageByDay, usageTotals, type UsageByDay, type UsageTotal } from "./usage";

export type ModelsOptions = {
  /**
   * The model Providers the Host installed (spec #875): each `@tanstack/ai-*` package as a
   * `ModelProvider`, keyed by Provider id. A Model of a Provider not passed here has no adapter.
   */
  providers?: ModelProviders;
  /**
   * The Host's own credentials (ADR 0007). A Provider entry carries its Models; a Tool entry (`tool:
   * "tavily"`) carries its price per search. Never stored.
   */
  hostProviders?: Array<HostProvider | HostTool>;
  /** Whether users may use their own Provider credentials. Defaults to `true` (ADR 0007). */
  byok?: boolean;
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
   * to the `providers`' image adapters. A Host passes a fake here to try the tool.
   */
  imageAdapterFor?: ModelsDeps["imageAdapterFor"];
  /**
   * The Host's linked Provider credentials (ADR 0023): for a user and a service, the credentials
   * the Host holds for them (a ChatGPT plan's access token as OpenAI's `apiKey`), nothing, or
   * `"needs-reconnect"`. Asked only for OpenAI, for the plan's Models, when the user has no key.
   * Without it, no one has linked credentials.
   */
  linkedCredentials?: LinkedCredentialsHook;
};

/**
 * The core's Models (`sdk.models`, spec #871): who pays for a call and with which
 * credentials, the Models a user can pick, metering and the Quota.
 */
export type ModelsApi = ModelsDomain & {
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
  /** The user's Image Model pick, or `null` for the Host's default (`model_settings`). */
  imageModelSetting: (userId: string) => Promise<string | null>;
  /** Saves the user's Image Model pick; `null` is the Host's default. The caller checks the id. */
  saveImageModelSetting: (userId: string, imageModel: string | null) => Promise<void>;
  /**
   * The Image Model image generation uses for the user: their pick, else the Host's default, else
   * none (`null`). A pick they can no longer use gives none.
   */
  resolveUserImageModel: (userId: string) => Promise<ResolvedImageModel | null>;
  readQuota: (userId: string) => ReturnType<typeof readQuota>;
  messageUsage: typeof messageUsage;
  loadCredentials: (userId: string, service: string) => Promise<Credentials | null>;
  /** The text adapter for a `"provider:model"` id (`ModelsDeps.adapterFor`). */
  adapterFor: ModelsDeps["adapterFor"];
  /**
   * The text adapter a resolved call runs on: its credentials, the Host's output cap, and a linked
   * plan's way (ADR 0023). A broken link gives an adapter that fails asking to reconnect ChatGPT.
   */
  adapterForCall: (model: string, call: ModelCall) => AnyTextAdapter;
  /**
   * The meter of a call to `model` on the user's own key or linked plan that is still recorded, at
   * cost 0: a Bot's calls, so its cache use shows whoever pays (#667).
   */
  freeModelMeter: (userId: string, model: string) => ModelMeter;
  /**
   * Registers a source of the user's recent Model (a function from a user to a Model id or nothing).
   * `listAvailableModels`'s default is the first registered source's Model the user can use, else
   * the Host's default.
   */
  addRecentModelSource: (source: RecentModelSource) => void;
  /** The image adapter for an Image Model, or `undefined` (`ModelsDeps.imageAdapterFor`). */
  imageAdapterFor: ModelsDeps["imageAdapterFor"];
  /** The size and provider options one image call sends (spec #278). */
  imageRequestFor: typeof imageRequestFor;
  /** Whether users may use their own Provider credentials (`byok`, ADR 0007). */
  readonly byok: boolean;
  /** The Host's default Image Model, or `null`. */
  readonly defaultImageModel: string | null;
  /** Whether the Host offers any Image Model (`hostProviders`'s `imageModels`). */
  readonly hasHostImageModels: boolean;
  // `usageTotals`, `usage` and `quota` are server-only reads for the Host's Admin views (spec #277).
  // No HTTP route: the Host decides who may call them. They never return Conversation content.
  /**
   * Every user's recorded calls created in `[since, until)`: on Host credentials, and at cost 0 on
   * their own key or linked plan (#667).
   */
  usageTotals: (range: { since: Date; until: Date }) => Promise<UsageTotal[]>;
  /** One user's calls per UTC day and Model in `[since, until)` (spec #277). */
  usage: (args: { userId: string; since: Date; until: Date }) => Promise<UsageByDay[]>;
  /** A user's budget and spend in micros, with its window's reset time; `null` when unlimited. */
  quota: (userId: string) => Promise<QuotaState | null>;
};

/** The rate-limit rules the `models` plugin declares, and their defaults. */
const modelsRateLimits = {
  credentialSave: defaultRateLimits.credentialSave,
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
  const plugin: ModelsPlugin = {
    id: "models",
    router: modelsPluginRouter,
    rateLimits: modelsRateLimits,
    // The core's `models` service, set before any plugin that calls it is initialised.
    init: (sdk) => {
      const deps = ready(sdk);
      const api = modelsApi(deps);
      bindModelsDeps(api, deps);
      sdk.models = api;
    },
    start: async (sdk) => {
      await start?.(sdk, ready(sdk));
    },
    exportUser: async (_sdk, userId, tx) => ({
      // Read in the export's snapshot, not through the pool.
      imageModel: await loadImageModelSetting({ db: tx }, userId),
    }),
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
  return plugin;
}

/** The production `ModelsDeps`, over the core context. Exported for its test. */
export function productionDeps(sdk: BotSdkContext, options: ModelsOptions): ModelsDeps {
  const providers = options.providers ?? {};
  const adapters = adaptersOf(providers);
  return {
    db: sdk.db,
    keyEncryptionSecrets: sdk.keyring,
    hooks: sdk.events,
    logger: sdk.logger,
    fetch: sdk.fetch,
    ollamaFetch: globalThis.fetch,
    providers,
    adapterFor: adapters.adapterFor,
    imageAdapterFor: options.imageAdapterFor ?? adapters.imageAdapterFor,
    hostProviders: (options.hostProviders ?? []).filter(isHostProvider),
    hostTools: (options.hostProviders ?? []).filter(isHostTool),
    byok: options.byok ?? true,
    linkedCredentials: options.linkedCredentials,
    defaultImageModel: options.defaultImageModel ?? null,
    recentModelSources: [],
    getQuota: quotaLookup(options.getQuota),
  };
}

/** The API bound to `deps`. The values read `deps` on each access, so they follow it. */
function modelsApi(deps: ModelsDeps): ModelsApi {
  const domain = modelsDomain(deps);
  return {
    ...domain,
    resolveModelCall: (userId, id) => resolveModelCall(deps, userId, id),
    resolveToolCall: (userId, tool) => resolveToolCall(deps, userId, tool),
    resolvePayer: (userId, services, hostOffer) => resolvePayer(deps, userId, services, hostOffer),
    resolveModel: (userId, id) => resolveModel(deps, userId, id),
    listAvailableModels: (userId) => listAvailableModels(deps, userId),
    resolveImageModel: (userId, id) => resolveImageModel(deps, userId, id),
    imageModelSetting: (userId) => loadImageModelSetting(deps, userId),
    saveImageModelSetting: (userId, imageModel) => saveImageModelSetting(deps, userId, imageModel),
    resolveUserImageModel: (userId) => resolveUserImageModel(deps, userId),
    readQuota: (userId) => readQuota(deps, userId),
    messageUsage,
    loadCredentials: (userId, service) => loadCredentials(deps, userId, service),
    adapterFor: (model, credentials, adapterOptions) =>
      deps.adapterFor(model, credentials, adapterOptions),
    adapterForCall: (model, call) =>
      call.linked === "needs-reconnect"
        ? reconnectChatgptAdapter(model)
        : deps.adapterFor(model, call.credentials, {
            maxOutputTokens: call.maxOutputTokens,
            ...(call.linked === "plan" && { linked: true }),
          }),
    freeModelMeter: (userId, model) => freeModelMeter(deps, userId, model),
    addRecentModelSource: (source) => {
      deps.recentModelSources.push(source);
    },
    imageAdapterFor: (model, credentials) => deps.imageAdapterFor(model, credentials),
    imageRequestFor,
    get byok() {
      return deps.byok;
    },
    get defaultImageModel() {
      return deps.defaultImageModel;
    },
    get hasHostImageModels() {
      return hostImageModelList(deps).length > 0;
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
  const hostProviders = (options.hostProviders ?? []).filter(isHostProvider);
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
