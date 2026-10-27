import type { Credentials, ModelProvider, ModelProviders } from "@botsdk/bot/models";
import type { AnyTextAdapter } from "@tanstack/ai";
import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter, type BedrockConverseModels } from "@tanstack/ai-bedrock";
import { createBytePlusImage, createBytePlusText } from "@tanstack/ai-byteplus";
import {
  createCloudflareImage,
  createCloudflareText,
  type CloudflareImageModel,
} from "@tanstack/ai-cloudflare";
import {
  createGeminiChat,
  createGeminiImage,
  type GeminiImageModel,
  type GeminiTextModel,
} from "@tanstack/ai-gemini";
import { createGrokImage, createGrokText } from "@tanstack/ai-grok";
import { createGroqText } from "@tanstack/ai-groq";
import { createLLMGatewayText } from "@tanstack/ai-llmgateway";
import { createLovableImage, createLovableText } from "@tanstack/ai-lovable";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOllamaChat } from "@tanstack/ai-ollama";
import { createOpenaiChat, createOpenaiImage, type OpenAIChatModel } from "@tanstack/ai-openai";
import { createOpenRouterImage, createOpenRouterText } from "@tanstack/ai-openrouter";
import { OPENROUTER_CHAT_MODELS } from "@tanstack/ai-openrouter/model-meta";
import { createVercelGatewayImage, createVercelGatewayText } from "@tanstack/ai-vercel-gateway";

/** The model id type of an adapter factory. The ids are checked in `models.test.ts`. */
type ModelOf<Factory extends (model: never, ...rest: never[]) => unknown> = Parameters<Factory>[0];

/** The API key of a Provider's credentials, or a refusal naming the Provider. */
function apiKeyOf(provider: string, credentials: Credentials): string {
  if (!credentials.apiKey) throw new Error(`The ${provider} credentials have no API key`);
  return credentials.apiKey;
}

/** The Cloudflare account id of the credentials, or a refusal. */
function accountIdOf(credentials: Credentials): string {
  if (!credentials.accountId) throw new Error("The cloudflare credentials have no account id");
  return credentials.accountId;
}

/**
 * The model Providers this app installs (spec #875), passed into `models.providers`: each
 * `@tanstack/ai-*` package through its explicit-credential factories. OpenAI's adapter takes the
 * linked ChatGPT plan's `fetch` when the SDK passes one (ADR 0023).
 */
export const modelProviders = {
  anthropic: {
    text: (model, credentials) =>
      createAnthropicChat(model as AnthropicChatModel, apiKeyOf("anthropic", credentials)),
  },
  openai: {
    text: (model, credentials, { fetch }) =>
      createOpenaiChat(
        model as OpenAIChatModel,
        apiKeyOf("openai", credentials),
        fetch ? { fetch } : undefined,
      ),
    // The linked ChatGPT plan's calls go through the fetch the SDK passes (ADR 0023).
    honoursFetch: true,
    image: (model, credentials) =>
      createOpenaiImage(
        model as ModelOf<typeof createOpenaiImage>,
        apiKeyOf("openai", credentials),
      ),
  },
  gemini: {
    text: (model, credentials) =>
      createGeminiChat(model as GeminiTextModel, apiKeyOf("gemini", credentials)),
    image: (model, credentials) =>
      createGeminiImage(model as GeminiImageModel, apiKeyOf("gemini", credentials)),
  },
  openrouter: {
    text: (model, credentials) =>
      createOpenRouterText(
        model as ModelOf<typeof createOpenRouterText>,
        apiKeyOf("openrouter", credentials),
      ),
    image: (model, credentials) =>
      createOpenRouterImage(
        model as ModelOf<typeof createOpenRouterImage>,
        apiKeyOf("openrouter", credentials),
      ),
    // The live list keeps only the Models the adapter knows.
    chatModels: OPENROUTER_CHAT_MODELS,
  },
  mistral: {
    text: (model, credentials) =>
      createMistralText(
        model as ModelOf<typeof createMistralText>,
        apiKeyOf("mistral", credentials),
      ),
  },
  groq: {
    text: (model, credentials) =>
      createGroqText(model as ModelOf<typeof createGroqText>, apiKeyOf("groq", credentials)),
  },
  grok: {
    text: (model, credentials) =>
      createGrokText(model as ModelOf<typeof createGrokText>, apiKeyOf("grok", credentials)),
    image: (model, credentials) =>
      createGrokImage(model as ModelOf<typeof createGrokImage>, apiKeyOf("grok", credentials)),
  },
  bedrock: {
    text: (model, credentials) =>
      createAbortableBedrockText(model as BedrockConverseModels, {
        apiKey: apiKeyOf("bedrock", credentials),
        region: credentials.region,
      }),
  },
  cloudflare: {
    text: (model, credentials) =>
      createCloudflareText(model, {
        accountId: accountIdOf(credentials),
        apiKey: apiKeyOf("cloudflare", credentials),
      }),
    image: (model, credentials) =>
      createCloudflareImage(model as CloudflareImageModel, {
        accountId: accountIdOf(credentials),
        apiKey: apiKeyOf("cloudflare", credentials),
      }),
  },
  byteplus: {
    text: (model, credentials) =>
      createBytePlusText(
        model as ModelOf<typeof createBytePlusText>,
        apiKeyOf("byteplus", credentials),
      ),
    image: (model, credentials) =>
      createBytePlusImage(
        model as ModelOf<typeof createBytePlusImage>,
        apiKeyOf("byteplus", credentials),
      ),
  },
  llmgateway: {
    text: (model, credentials) =>
      createLLMGatewayText(
        model as ModelOf<typeof createLLMGatewayText>,
        apiKeyOf("llmgateway", credentials),
      ),
  },
  lovable: {
    text: (model, credentials) =>
      createLovableText(
        model as ModelOf<typeof createLovableText>,
        apiKeyOf("lovable", credentials),
      ),
    image: (model, credentials) =>
      createLovableImage(
        model as ModelOf<typeof createLovableImage>,
        apiKeyOf("lovable", credentials),
      ),
  },
  "vercel-gateway": {
    text: (model, credentials) =>
      createVercelGatewayText(
        model as ModelOf<typeof createVercelGatewayText>,
        apiKeyOf("vercel-gateway", credentials),
      ),
    image: (model, credentials) =>
      createVercelGatewayImage(
        model as ModelOf<typeof createVercelGatewayImage>,
        apiKeyOf("vercel-gateway", credentials),
      ),
  },
  ollama: {
    text: (model, credentials) => {
      if (!credentials.host) throw new Error("The ollama credentials have no host");
      return createOllamaChat(model, credentials.host);
    },
  },
} satisfies Record<string, ModelProvider> as ModelProviders;

/**
 * Bedrock's Converse adapter doesn't hand the run's abort signal to the AWS SDK, so Stop would
 * leave the request to Bedrock running (issue #54). The SDK adds the signal to requests that go
 * through `wrapFetch` (Mistral's), but Bedrock's go through the AWS SDK's own client, so this one
 * passes it to `send`. Each run builds its own adapter, so the signal of the run in progress fits
 * on the instance.
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
