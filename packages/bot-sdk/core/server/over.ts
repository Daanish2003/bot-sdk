import {
  buildBotSdk,
  type BotSdk,
  type BotSdkOptions,
  type ChatHandler,
  type GivenContext,
} from "./create-chat";
import { enabledPlugins, type BotSdkContext, type BotSdkPlugin } from "./plugin";
import { modelsOver } from "../../plugins/models/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";
import type { JobRunner } from "../../plugins/runner/server/jobs/runner";
import { runner, runnerJobs } from "../../plugins/runner/server/plugin";

type OverOptions = Pick<BotSdkOptions, "basePath" | "getUser" | "logger">;

/**
 * What the tests and evals drive: the core context of an instance over fakes, with its `models`
 * plugin's bundle.
 */
export type SdkOver = BotSdkContext & ModelsDeps;

/**
 * A real instance whose core context, `models` and `runner` plugins take the given parts in place
 * of built ones: the seam the tests and evals drive with fakes. Returns the instance and its
 * context with the `models` bundle.
 */
export function createBotSdkOver(
  given: {
    context: GivenContext;
    models: ModelsDeps;
    /** The `runner` plugin's jobs runner; the in-process runner by default. */
    jobs?: JobRunner;
    /** More plugins, enabled after `models` and `runner`. */
    plugins?: readonly BotSdkPlugin[];
  },
  options: OverOptions,
): { instance: BotSdk; sdk: SdkOver } {
  const { instance, context } = buildBotSdk(
    {
      ...options,
      databaseUrl: "",
      keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets,
      plugins: [modelsOver(given.models), runner({ jobs: given.jobs }), ...(given.plugins ?? [])],
    },
    given.context,
  );
  return { instance, sdk: { ...given.models, ...context } };
}

/**
 * The handler of a new instance over `sdk`'s parts (a `createBotSdkOver` context, or a copy of one
 * with some parts replaced): its core context, `models` bundle and jobs runner, and the other
 * plugins `sdk` enabled.
 */
export function createChatHandler(sdk: SdkOver, options: OverOptions): ChatHandler {
  const { plugin: _plugin, hasPlugin: _hasPlugin, rateLimit: _rateLimit, ...context } = sdk;
  // Its own sources: the plugins register theirs again when the new instance runs their inits.
  const models = {
    ...sdk,
    hooks: sdk.events,
    keyEncryptionSecrets: sdk.keyring,
    recentModelSources: [],
  };
  const plugins = enabledPlugins(sdk).filter(({ id }) => !["models", "runner"].includes(id));
  return createBotSdkOver({ context, models, jobs: runnerJobs(sdk), plugins }, options).instance
    .handler;
}
