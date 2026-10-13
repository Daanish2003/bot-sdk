import type { AnyImageAdapter, AnyTextAdapter } from "@tanstack/ai";
import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter, type BedrockConverseModels } from "@tanstack/ai-bedrock";
import { createBytePlusText } from "@tanstack/ai-byteplus";
import { createCloudflareText } from "@tanstack/ai-cloudflare";
import { createGeminiChat, type GeminiTextModel } from "@tanstack/ai-gemini";
import { createGrokText } from "@tanstack/ai-grok";
import { createGroqText } from "@tanstack/ai-groq";
import { createLLMGatewayText } from "@tanstack/ai-llmgateway";
import { createLovableText } from "@tanstack/ai-lovable";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOllamaChat } from "@tanstack/ai-ollama";
import { createOpenaiChat, type OpenAIChatModel } from "@tanstack/ai-openai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { createVercelGatewayText } from "@tanstack/ai-vercel-gateway";

import type { Credentials } from "../deps";
import { isKnownModel, parseModelId } from "../../shared/chat/models";

/** The model id type of an adapter factory. The ids are checked in `models.test.ts`. */
type ModelOf<Factory extends (model: never, ...rest: never[]) => unknown> = Parameters<Factory>[0];

/**
 * Builds the real TanStack AI text adapter for a `"provider:model"` id (curated, or from the live
 * OpenRouter or Ollama list) from the user's Provider credentials, each through its
 * explicit-credential factory. The production `deps.adapterFor`.
 */
export function adapterFor(model: string, credentials: Credentials): AnyTextAdapter {
  const parsed = parseModelId(model);
  if (!parsed || !isKnownModel(model)) {
    throw new Error(`"${model}" is not an available Model`);
  }
  const { provider, modelId } = parsed;

  if (provider === "ollama") {
    if (!credentials.host) throw new Error("The ollama credentials have no host");
    return createOllamaChat(modelId, credentials.host);
  }
  const apiKey = credentials.apiKey;
  if (!apiKey) throw new Error(`The ${provider} credentials have no API key`);

  switch (provider) {
    case "anthropic":
      return createAnthropicChat(modelId as AnthropicChatModel, apiKey);
    case "openai":
      return createOpenaiChat(modelId as OpenAIChatModel, apiKey);
    case "gemini":
      return createGeminiChat(modelId as GeminiTextModel, apiKey);
    case "openrouter":
      return createOpenRouterText(modelId as ModelOf<typeof createOpenRouterText>, apiKey);
    case "mistral":
      return createMistralText(modelId as ModelOf<typeof createMistralText>, apiKey);
    case "groq":
      return createGroqText(modelId as ModelOf<typeof createGroqText>, apiKey);
    case "grok":
      return createGrokText(modelId as ModelOf<typeof createGrokText>, apiKey);
    case "bedrock":
      return createAbortableBedrockText(modelId as BedrockConverseModels, {
        apiKey,
        region: credentials.region,
      });
    case "cloudflare":
      if (!credentials.accountId) throw new Error("The cloudflare credentials have no account id");
      return createCloudflareText(modelId, { accountId: credentials.accountId, apiKey });
    case "byteplus":
      return createBytePlusText(modelId as ModelOf<typeof createBytePlusText>, apiKey);
    case "llmgateway":
      return createLLMGatewayText(modelId as ModelOf<typeof createLLMGatewayText>, apiKey);
    case "lovable":
      return createLovableText(modelId as ModelOf<typeof createLovableText>, apiKey);
    case "vercel-gateway":
      return createVercelGatewayText(modelId as ModelOf<typeof createVercelGatewayText>, apiKey);
    default:
      throw new Error(`No adapter is available for the ${provider} Provider`);
  }
}

/**
 * The image adapter for an Image Model (spec #278). The Provider image adapters come with their
 * own ticket; until one is wired here, no Image Model has an adapter, so its call fails.
 */
export function imageAdapterFor(_model: string, _credentials: Credentials): AnyImageAdapter {
  throw new Error("No image adapter is available for this Image Model");
}

/**
 * Bedrock's Converse adapter doesn't hand the run's abort signal to the AWS SDK, so Stop would
 * leave the request to Bedrock running (issue #54). This one passes it to `send`. Each run builds
 * its own adapter, so the signal of the run in progress fits on the instance.
 */
class AbortableBedrockConverseAdapter<
  TModel extends BedrockConverseModels,
> extends BedrockConverseTextAdapter<TModel> {
  private signal: AbortSignal | undefined;

  override async *chatStream(
    options: Parameters<BedrockConverseTextAdapter<TModel>["chatStream"]>[0],
  ) {
    this.signal = options.request?.signal ?? undefined;
    yield* super.chatStream(options);
  }

  protected override async sendStream(
    input: Parameters<BedrockConverseTextAdapter<TModel>["sendStream"]>[0],
  ) {
    const { ConverseStreamCommand } = await this.importBedrockRuntime();
    const client = await this.getClient();
    const response = await client.send(new ConverseStreamCommand(input), {
      abortSignal: this.signal,
    });
    if (!response.stream) throw new Error("Bedrock Converse: empty stream response");
    return response.stream;
  }
}

/**
 * The Bedrock Converse adapter, with Stop cancelling the request. `auth: "apikey"` keeps it off
 * the server's AWS env credentials. `baseURL` is for tests.
 */
export function createAbortableBedrockText(
  model: BedrockConverseModels,
  config: { apiKey: string; region?: string; baseURL?: string },
): AnyTextAdapter {
  return new AbortableBedrockConverseAdapter({ ...config, auth: "apikey" }, model);
}
