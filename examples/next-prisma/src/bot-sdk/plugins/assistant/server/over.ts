import {
  buildBotSdk,
  type BotSdk,
  type BotSdkOptions,
  type ChatHandler,
  type GivenContext,
} from "../../../core/server/create-chat";
import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import { modelsOver } from "../../models/server/plugin";
import type { ModelsDeps } from "../../models/server/types";
import { assistantOver } from "./plugin";
import { assistantState, type AssistantState } from "./state";

type OverOptions = Pick<BotSdkOptions, "basePath" | "getUser" | "getClientIp" | "logger">;

/**
 * What the tests and evals drive: the core context of an instance over fakes, with its `models`
 * plugin's bundle. The `assistant` plugin's state is `assistantState(sdk)`.
 */
export type SdkOver = BotSdkContext & ModelsDeps;

/**
 * A real instance whose core context, `models` and `assistant` plugins take the given parts in place
 * of built ones: the seam the tests and evals drive with fakes. Returns the instance and its
 * context with the `models` bundle.
 */
export function createBotSdkOver(
  given: {
    context: GivenContext;
    models: ModelsDeps;
    assistant: Partial<AssistantState>;
    /** More plugins, enabled after `models` and the assistant. */
    plugins?: readonly BotSdkPlugin[];
  },
  options: OverOptions,
): { instance: BotSdk; sdk: SdkOver } {
  const { instance, context } = buildBotSdk(
    {
      ...options,
      databaseUrl: "",
      keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets,
      plugins: [modelsOver(given.models), assistantOver(given.assistant), ...(given.plugins ?? [])],
    },
    given.context,
  );
  return { instance, sdk: { ...given.models, ...context } };
}

/**
 * The handler of a new instance over `sdk`'s parts (a `createBotSdkOver` context, or a copy of one
 * with some parts replaced): its core context, `models` bundle and `assistant` state.
 */
export function createChatHandler(sdk: SdkOver, options: OverOptions): ChatHandler {
  const { plugin: _plugin, rateLimit: _rateLimit, ...context } = sdk;
  const models = { ...sdk, hooks: sdk.events, keyEncryptionSecrets: sdk.keyring };
  return createBotSdkOver({ context, models, assistant: assistantState(sdk) }, options).instance
    .handler;
}
