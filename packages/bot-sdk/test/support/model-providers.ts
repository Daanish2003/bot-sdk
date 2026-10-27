import type { Credentials, ModelProviders } from "@botsdk/bot/models";
import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import {
  createGeminiChat,
  createGeminiImage,
  type GeminiImageModel,
  type GeminiTextModel,
} from "@tanstack/ai-gemini";
import { createOpenaiChat, createOpenaiImage, type OpenAIChatModel } from "@tanstack/ai-openai";
import { createOpenRouterImage, createOpenRouterText } from "@tanstack/ai-openrouter";
import { OPENROUTER_CHAT_MODELS } from "@tanstack/ai-openrouter/model-meta";

function apiKeyOf(provider: string, credentials: Credentials): string {
  if (!credentials.apiKey) throw new Error(`The ${provider} credentials have no API key`);
  return credentials.apiKey;
}

/**
 * The model Providers the tests and evals install (spec #875): the four the evals run on, as a
 * Host passes them in `models.providers`. apps/web installs every Provider (its model-providers.ts).
 */
export const testModelProviders: ModelProviders = {
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
    image: (model, credentials) =>
      createOpenaiImage(
        model as Parameters<typeof createOpenaiImage>[0],
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
        model as Parameters<typeof createOpenRouterText>[0],
        apiKeyOf("openrouter", credentials),
      ),
    image: (model, credentials) =>
      createOpenRouterImage(
        model as Parameters<typeof createOpenRouterImage>[0],
        apiKeyOf("openrouter", credentials),
      ),
    chatModels: OPENROUTER_CHAT_MODELS,
  },
};
