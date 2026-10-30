import {
  buildBotSdk,
  coreParts,
  type BotSdk,
  type BotSdkOptions,
  type FeatureEntry,
  type GivenContext,
} from "./create-chat";
import {
  createHttpHandler,
  createScreenSocket,
  type HttpHandler,
  type HttpHandlerOptions,
  type ScreenSocketHooks,
} from "./http";
import { postgres } from "./database";
import { enabledFeatures } from "./feature";
import { enabledPlugins, type BotSdkContext } from "./plugin";
import { modelsOver } from "./models/internal";
import type { ModelsDeps } from "./models/internal";
import { computerProvider } from "./computer/internal";
import type { ComputerProvider } from "./computer/internal";
import type { JobRunner } from "./runner/internal";
import { runnerJobs } from "./runner/internal";

type OverOptions = Pick<BotSdkOptions, "logger">;

/** The factory's options the seam passes on as they are. */
export type OverSlots = Pick<
  BotSdkOptions,
  "channels" | "channelAppUrl" | "users" | "reviewModel" | "safety" | "liveViewBase"
>;

/**
 * What the tests and evals drive: the core context of an instance over fakes, with its Models
 * bundle.
 */
export type SdkOver = BotSdkContext & ModelsDeps;

/**
 * A real instance whose core context, Models, runner and Computer take the given parts in place of
 * built ones: the seam the tests and evals drive with fakes. The other slots are the factory's.
 * Returns the instance and its context with the Models bundle.
 */
export function createBotSdkOver(
  given: OverSlots & {
    context: GivenContext;
    models: ModelsDeps;
    /** The runner slot's jobs runner; the in-process runner by default. */
    jobs?: JobRunner;
    /** The computer slot's provider; no Computer by default. */
    computer?: ComputerProvider;
    /** The features, as the `features` slot takes them. */
    features?: readonly FeatureEntry[];
  },
  options: OverOptions,
): { instance: BotSdk; sdk: SdkOver } {
  const slots: BotSdkOptions = {
    ...options,
    database: postgres({ connectionString: "" }),
    keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets,
    models: {},
    computer: given.computer,
    features: given.features,
    channels: given.channels,
    channelAppUrl: given.channelAppUrl,
    users: given.users,
    reviewModel: given.reviewModel,
    safety: given.safety,
    liveViewBase: given.liveViewBase,
  };
  const { instance, context } = buildBotSdk(
    slots,
    { ...given.context, ...(given.jobs && { jobs: given.jobs }) },
    coreParts(slots, modelsOver(given.models)),
  );
  return { instance, sdk: { ...given.models, ...context } };
}

/**
 * The HTTP handler (`createHttpHandler`) of a new instance over `sdk`'s parts (a `createBotSdkOver`
 * context, or a copy of one with some parts replaced): its core context, Models bundle, jobs runner
 * and Computer provider, and the same core parts and features.
 */
export function createHttpHandlerOver(sdk: SdkOver, options: HttpHandlerOptions): HttpHandler {
  return createHttpHandler(instanceOver(sdk), options);
}

/** The live view's socket hooks (`createScreenSocket`) of a new instance over `sdk`'s parts, as above. */
export function createScreenSocketOver(
  sdk: SdkOver,
  options: { basePath: string },
): ScreenSocketHooks {
  return createScreenSocket(instanceOver(sdk), options);
}

/** A new instance over `sdk`'s parts, for `createHttpHandlerOver` and `createScreenSocketOver`. */
function instanceOver(sdk: SdkOver): BotSdk {
  const {
    parts: _parts,
    models: _models,
    runner: _runner,
    computer,
    bots: _bots,
    conversations: _conversations,
    secrets: _secrets,
    screens: _screens,
    routines: _routines,
    checkIns: _checkIns,
    triggers: _triggers,
    helpers: _helpers,
    demonstrations: _demonstrations,
    reviews: _reviews,
    rules: _rules,
    notifications: _notifications,
    channels: _channels,
    ...context
  } = sdk;
  // Its own sources: the parts register theirs again when the new instance runs their inits.
  const models = {
    ...context,
    hooks: sdk.events,
    keyEncryptionSecrets: sdk.keyring,
    recentModelSources: [],
  };
  const features = enabledFeatures(sdk).map(({ feature }) => feature);
  const featureIds = new Set(features.map(({ id }) => id));
  // The Bots and Channels as `sdk` built them, after Models over the new bundle.
  const core = enabledPlugins(sdk).filter(({ id }) => id !== "models" && !featureIds.has(id));
  const { instance } = buildBotSdk(
    {
      database: postgres({ connectionString: "" }),
      logger: sdk.logger,
      keyEncryptionSecrets: sdk.keyring,
      models: {},
      ...(computer && { computer: computerProvider(computer) }),
      features,
    },
    { ...context, jobs: runnerJobs(sdk) },
    [modelsOver(models), ...core],
  );
  return instance;
}
