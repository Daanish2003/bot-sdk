import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { HostKeysPage } from "../host-keys-page";
import { renderWrapped, untranslated } from "../fake-dictionary";

const model: ListedModel = {
  id: "anthropic:claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  provider: "anthropic",
  modelId: "claude-haiku-4-5",
  images: true,
  pdfs: true,
  tools: true,
  contextWindow: null,
  maxOutputTokens: null,
  onHostCredentials: false,
  reasoning: { efforts: [], off: false, defaultEffort: null },
};

/**
 * Text the dictionary doesn't translate: the user's key hint, and the Model and Provider names and
 * their descriptions, which core/shared/credentials owns (a follow-up).
 */
const ownedContent = [
  "Claude Haiku 4.5",
  "Anthropic",
  "abcd",
  "OpenAI",
  "Google Gemini",
  "OpenRouter",
  "Mistral",
  "Groq",
  "xAI Grok",
  "Amazon Bedrock",
  "Cloudflare Workers AI",
  "BytePlus",
  "LLM Gateway",
  "Lovable",
  "Vercel AI Gateway",
  "Ollama",
  "Tavily",
  "Web search",
];

function seedModels(queryClient: QueryClient, client: BotSdkClient) {
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [model],
    defaultModel: null,
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: false,
  });
}

function expectTranslated(
  ui: ReactElement,
  seed?: (queryClient: QueryClient, client: BotSdkClient) => void,
) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, ownedContent)).toEqual([]);
  return html;
}

describe("the keys page with the dictionary", () => {
  it("shows no untranslated text on the keys page, with credentials on", () => {
    expectTranslated(createElement(HostKeysPage), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
      queryClient.setQueryData(client.orpc.credentials.list.queryKey(), []);
      queryClient.setQueryData(client.orpc.models.imageModel.queryKey(), { imageModel: null });
      queryClient.setQueryData(client.orpc.settings.get.queryKey(), {
        backgroundModel: null,
        instructions: null,
      });
      queryClient.setQueryData(client.orpc.connections.list.queryKey(), { servers: [] });
      seedModels(queryClient, client);
    });
  });

  it("shows no untranslated text on the OpenAI row's ChatGPT link, in each state", () => {
    const linkedCredentials = { connect: () => {}, disconnect: () => {} };
    for (const state of ["none", "linked", "needs-reconnect", "key"] as const) {
      const html = expectTranslated(
        createElement(HostKeysPage, { linkedCredentials }),
        (queryClient, client) => {
          queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
          queryClient.setQueryData(
            client.orpc.credentials.list.queryKey(),
            state === "key" ? [{ service: "openai", hint: "abcd", verified: true }] : [],
          );
          queryClient.setQueryData(client.orpc.credentials.openaiState.queryKey(), state);
          queryClient.setQueryData(client.orpc.models.imageModel.queryKey(), { imageModel: null });
          queryClient.setQueryData(client.orpc.settings.get.queryKey(), {
            backgroundModel: null,
            instructions: null,
          });
          queryClient.setQueryData(client.orpc.connections.list.queryKey(), { servers: [] });
          seedModels(queryClient, client);
        },
      );
      expect(html).toContain("ChatGPT");
    }
  });
});
