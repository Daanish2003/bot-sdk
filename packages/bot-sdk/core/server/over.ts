import {
  buildBotSdk,
  coreParts,
  type BotSdk,
  type BotSdkOptions,
  type ChatHandler,
  type FeatureEntry,
  type GivenContext,
} from "./create-chat";
import { enabledFeatures } from "./feature";
import { enabledPlugins, type BotSdkContext } from "./plugin";
import { modelsOver } from "../../plugins/models/server/internal";
import type { ModelsDeps } from "../../plugins/models/server/internal";
import { computerProvider } from "../../plugins/computer/server/internal";
import type { ComputerProvider } from "../../plugins/computer/server/internal";
import type { JobRunner } from "../../plugins/runner/server/internal";
import { runnerJobs } from "../../plugins/runner/server/internal";

type OverOptions = Pick<BotSdkOptions, "basePath" | "getUser" | "logger">;

/** The factory's options the seam passes on as they are. */
export type OverSlots = Pick<BotSdkOptions, "channels" | "verifiedEmail" | "reviewModel">;

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
    databaseUrl: "",
    keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets,
    models: {},
    computer: given.computer,
    features: given.features,
    channels: given.channels,
    verifiedEmail: given.verifiedEmail,
    reviewModel: given.reviewModel,
  };
  const { instance, context } = buildBotSdk(
    slots,
    { ...given.context, ...(given.jobs && { jobs: given.jobs }) },
    coreParts(slots, modelsOver(given.models)),
  );
  return { instance, sdk: { ...given.models, ...context } };
}

/**
 * The handler of a new instance over `sdk`'s parts (a `createBotSdkOver` context, or a copy of one
 * with some parts replaced): its core context, Models bundle, jobs runner and Computer provider,
 * and the same core parts and features.
 */
export function createChatHandler(sdk: SdkOver, options: OverOptions): ChatHandler {
  const {
    parts: _parts,
    rateLimit: _rateLimit,
    models: _models,
    runner: _runner,
    computer,
    bots: _bots,
    conversations: _conversations,
    secrets: _secrets,
    screens: _screens,
    routines: _routines,
    checkIns: _checkIns,
    helpers: _helpers,
    demonstrations: _demonstrations,
    reviews: _reviews,
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
  return buildBotSdk(
    {
      ...options,
      databaseUrl: "",
      keyEncryptionSecrets: sdk.keyring,
      models: {},
      ...(computer && { computer: computerProvider(computer) }),
      features,
    },
    { ...context, jobs: runnerJobs(sdk) },
    [modelsOver(models), ...core],
  ).instance.handler;
}
