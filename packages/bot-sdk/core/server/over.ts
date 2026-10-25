import {
  buildBotSdk,
  type BotSdk,
  type BotSdkOptions,
  type ChatHandler,
  type FeatureEntry,
  type GivenContext,
} from "./create-chat";
import { enabledFeatures } from "./feature";
import { enabledPlugins, type BotSdkContext } from "./plugin";
import { bot } from "../../plugins/bot/server/plugin";
import { channel, type ChannelAdapter } from "../../plugins/channel/server/plugin";
import { modelsOver } from "../../plugins/models/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";
import { computerProvider } from "../../plugins/computer/server/plugin";
import type { ComputerProvider } from "../../plugins/computer/server/provider";
import type { JobRunner } from "../../plugins/runner/server/jobs/runner";
import { runnerJobs } from "../../plugins/runner/server/plugin";

type OverOptions = Pick<BotSdkOptions, "basePath" | "getUser" | "logger">;

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
  given: {
    context: GivenContext;
    models: ModelsDeps;
    /** The runner slot's jobs runner; the in-process runner by default. */
    jobs?: JobRunner;
    /** The computer slot's provider; no Computer by default. */
    computer?: ComputerProvider;
    /** The channels slot's adapters; no Channel besides web by default. */
    channels?: readonly ChannelAdapter[];
    /** The user's verified account email, as the factory's `verifiedEmail`. */
    verifiedEmail?: (userId: string) => Promise<string | null>;
    /** The Model that Auto-reviews the Bots' risky tool calls; the Bot's own by default. */
    reviewModel?: string;
    /** The features, as the `features` slot takes them. */
    features?: readonly FeatureEntry[];
  },
  options: OverOptions,
): { instance: BotSdk; sdk: SdkOver } {
  const { channels, verifiedEmail = async () => null } = given;
  const { instance, context } = buildBotSdk(
    {
      ...options,
      databaseUrl: "",
      keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets,
      models: {},
      runner: given.jobs,
      computer: given.computer,
      features: given.features,
    },
    given.context,
    [
      modelsOver(given.models),
      bot({ reviewModel: given.reviewModel }),
      ...(channels ? [channel({ adapters: channels, verifiedEmail })] : []),
    ],
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
      runner: runnerJobs(sdk),
      ...(computer && { computer: computerProvider(computer) }),
      features,
    },
    context,
    [modelsOver(models), ...core],
  ).instance.handler;
}
