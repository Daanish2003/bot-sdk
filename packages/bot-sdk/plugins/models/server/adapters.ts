import type { AnyEmbeddingAdapter, AnyImageAdapter, AnyTextAdapter } from "@tanstack/ai";
import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter, type BedrockConverseModels } from "@tanstack/ai-bedrock";
import { createBytePlusText } from "@tanstack/ai-byteplus";
import {
  createCloudflareImage,
  createCloudflareText,
  type CloudflareImageModel,
} from "@tanstack/ai-cloudflare";
import {
  createGeminiChat,
  createGeminiEmbedding,
  createGeminiImage,
  type GeminiEmbeddingModel,
  type GeminiImageModel,
  type GeminiTextModel,
  isGeminiNativeImageModel,
} from "@tanstack/ai-gemini";
import { createGrokImage, createGrokText } from "@tanstack/ai-grok";
import { createGroqText } from "@tanstack/ai-groq";
import { createLLMGatewayText } from "@tanstack/ai-llmgateway";
import { createLovableImage, createLovableText } from "@tanstack/ai-lovable";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOllamaChat } from "@tanstack/ai-ollama";
import {
  createOpenaiChat,
  createOpenaiEmbedding,
  createOpenaiImage,
  type OpenAIChatModel,
  type OpenAIEmbeddingModel,
} from "@tanstack/ai-openai";
import { createOpenRouterImage, createOpenRouterText } from "@tanstack/ai-openrouter";
import { createVercelGatewayImage, createVercelGatewayText } from "@tanstack/ai-vercel-gateway";
import { createBytePlusImage } from "@tanstack/ai-byteplus";

import type { Credentials } from "./types";
import type { AspectRatio } from "../../assistant/shared/chat/generated-image";
import { isKnownModel, parseModelId } from "../shared/models";

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

/** The API key of an image Provider's credentials, or a refusal naming the Provider. */
function imageApiKey(provider: string, credentials: Credentials): string {
  if (!credentials.apiKey) throw new Error(`The ${provider} credentials have no API key`);
  return credentials.apiKey;
}

/**
 * The TanStack AI embedding adapter for an embedding Model (`"provider:model"`, ADR 0014), from the
 * credentials it runs on. The production `deps.embeddingAdapterFor`. Only OpenAI and Gemini serve
 * embeddings; any other Provider throws.
 */
export function embeddingAdapterFor(model: string, credentials: Credentials): AnyEmbeddingAdapter {
  const parsed = parseModelId(model);
  if (!parsed) throw new Error(`"${model}" is not an embedding Model`);
  const { provider, modelId } = parsed;
  const apiKey = credentials.apiKey;
  if (!apiKey) throw new Error(`The ${provider} credentials have no API key`);

  switch (provider) {
    case "openai":
      return createOpenaiEmbedding(modelId as OpenAIEmbeddingModel, apiKey);
    case "gemini":
      return createGeminiEmbedding(modelId as GeminiEmbeddingModel, apiKey);
    default:
      throw new Error(`No embedding adapter is available for the ${provider} Provider`);
  }
}

/**
 * The TanStack AI image adapter for an Image Model (`"provider:model"`, spec #278), from the
 * credentials it runs on. The production `deps.imageAdapterFor`. A Provider with no image adapter
 * throws, so a Host Image Model on one fails loudly rather than offering a tool it can't serve.
 */
export function imageAdapterFor(model: string, credentials: Credentials): AnyImageAdapter {
  const parsed = parseModelId(model);
  if (!parsed) throw new Error(`"${model}" is not an Image Model`);
  const { provider, modelId } = parsed;

  switch (provider) {
    case "openai":
      return createOpenaiImage(
        modelId as ModelOf<typeof createOpenaiImage>,
        imageApiKey(provider, credentials),
      );
    case "gemini":
      return createGeminiImage(modelId as GeminiImageModel, imageApiKey(provider, credentials));
    case "grok":
      return createGrokImage(
        modelId as ModelOf<typeof createGrokImage>,
        imageApiKey(provider, credentials),
      );
    case "openrouter":
      return createOpenRouterImage(
        modelId as ModelOf<typeof createOpenRouterImage>,
        imageApiKey(provider, credentials),
      );
    case "byteplus":
      return createBytePlusImage(
        modelId as ModelOf<typeof createBytePlusImage>,
        imageApiKey(provider, credentials),
      );
    case "lovable":
      return createLovableImage(
        modelId as ModelOf<typeof createLovableImage>,
        imageApiKey(provider, credentials),
      );
    case "vercel-gateway":
      return createVercelGatewayImage(
        modelId as ModelOf<typeof createVercelGatewayImage>,
        imageApiKey(provider, credentials),
      );
    case "cloudflare":
      if (!credentials.accountId) throw new Error("The cloudflare credentials have no account id");
      return createCloudflareImage(modelId as CloudflareImageModel, {
        accountId: credentials.accountId,
        apiKey: imageApiKey(provider, credentials),
      });
    default:
      throw new Error(`No image adapter is available for the ${provider} Provider`);
  }
}

/** The size each image adapter takes for each aspect ratio, from its own size rules (spec #278). */
type SizeTable = Record<AspectRatio, string>;

const gptImageSizes: SizeTable = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/**
 * The size table of an Image Model. Each Provider's sizes come from its TanStack AI package
 * (validated there, so a value outside its list is refused by the adapter): OpenAI and the
 * gpt-image Models on Lovable, Vercel and Cloudflare take WIDTHxHEIGHT; Gemini's native Models
 * take `aspect_resolution`; Grok takes an aspect ratio; BytePlus takes pixels at 2K.
 */
function sizeTableFor(provider: string, modelId: string): SizeTable {
  switch (provider) {
    case "openai":
      if (modelId === "dall-e-2") {
        return { square: "1024x1024", landscape: "1024x1024", portrait: "1024x1024" };
      }
      if (modelId === "dall-e-3") {
        return { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" };
      }
      return gptImageSizes;
    case "gemini":
      return isGeminiNativeImageModel(modelId)
        ? { square: "1:1_1K", landscape: "16:9_1K", portrait: "9:16_1K" }
        : { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" };
    case "grok":
      return { square: "1:1", landscape: "16:9", portrait: "9:16" };
    case "byteplus":
      return { square: "2048x2048", landscape: "2560x1440", portrait: "1440x2560" };
    case "openrouter":
      return { square: "1024x1024", landscape: "1248x832", portrait: "832x1248" };
    case "lovable":
    case "vercel-gateway":
    case "cloudflare":
      return gptImageSizes;
    default:
      throw new Error(`No image sizes are known for the ${provider} Provider`);
  }
}

/** Providers whose image adapter takes a GPT-style `quality` (`low`, `medium`, `high`). */
const qualityProviders = new Set(["openai", "lovable"]);

/**
 * The size and provider options one `generate_image` call sends (spec #278). On Host credentials
 * the Host Image Model's pinned size and quality are used whatever the aspect ratio, so the flat
 * price is accurate. On a user's own credentials the aspect ratio maps to the nearest size the
 * adapter takes, and the quality is the adapter's default.
 */
export type ImageRequest = { size: string; modelOptions?: { quality: string } };

export function imageRequestFor(
  model: string,
  aspectRatio: AspectRatio,
  pinned?: { size: string; quality: string },
): ImageRequest {
  const parsed = parseModelId(model);
  if (!parsed) throw new Error(`"${model}" is not an Image Model`);
  if (!pinned) return { size: sizeTableFor(parsed.provider, parsed.modelId)[aspectRatio] };
  if (!qualityProviders.has(parsed.provider)) return { size: pinned.size };
  return { size: pinned.size, modelOptions: { quality: pinned.quality } };
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
