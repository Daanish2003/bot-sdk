import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { KeySettingsPage } from "../../../plugins/models/ui/key-settings";
import { ProjectPage } from "../../../ui/pages/project";
import { SharedConversationPage, SharedLinkNotFound } from "../../../ui/pages/shared-conversation";
import { renderWrapped, untranslated } from "../fake-dictionary";

const projectId = "00000000-0000-4000-8000-000000000001";

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
 * Text the dictionary doesn't translate: the user's own data, the locale date, and the Model and
 * Provider names and their descriptions, which core/shared/credentials owns (a follow-up).
 */
const ownedContent = [
  "Claude Haiku 4.5",
  "Anthropic",
  "Thesis",
  "Trip planning",
  "Where to next",
  "October 1, 2026",
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

const conversation = {
  id: "c1",
  title: "Trip planning",
  model: model.id,
  lastMessageAt: new Date(),
  preview: "Where to next",
  pinnedAt: null,
  projectId,
  shared: false,
  hasError: false,
};

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

function projectConversationsKey(client: BotSdkClient) {
  return client.orpc.conversation.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ cursor, projectId }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  }).queryKey;
}

function expectTranslated(
  ui: ReactElement,
  seed?: (queryClient: QueryClient, client: BotSdkClient) => void,
) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, ownedContent)).toEqual([]);
  return html;
}

describe("the pages with the dictionary", () => {
  it("shows no untranslated text on a Project, with its Conversations", () => {
    const html = expectTranslated(
      createElement(ProjectPage, { projectId }),
      (queryClient, client) => {
        queryClient.setQueryData(client.orpc.project.get.queryKey({ input: { id: projectId } }), {
          id: projectId,
          name: "Thesis",
          defaultModel: null,
          instructions: null,
        });
        queryClient.setQueryData(projectConversationsKey(client), {
          pages: [{ items: [conversation], nextCursor: null }],
          pageParams: [undefined],
        });
      },
    );

    expect(html).toContain("⟦Edit⟧");
  });

  it("shows no untranslated text on an empty Project", () => {
    const html = expectTranslated(
      createElement(ProjectPage, { projectId }),
      (queryClient, client) => {
        queryClient.setQueryData(client.orpc.project.get.queryKey({ input: { id: projectId } }), {
          id: projectId,
          name: "Thesis",
          defaultModel: null,
          instructions: null,
        });
        queryClient.setQueryData(projectConversationsKey(client), {
          pages: [{ items: [], nextCursor: null }],
          pageParams: [undefined],
        });
      },
    );

    expect(html).toContain("⟦Edit⟧");
  });

  it("shows no untranslated text on the Project's tabs, with its Knowledge file count", () => {
    const html = expectTranslated(
      createElement(ProjectPage, { projectId }),
      (queryClient, client) => {
        queryClient.setQueryData(client.orpc.project.get.queryKey({ input: { id: projectId } }), {
          id: projectId,
          name: "Thesis",
          defaultModel: null,
          instructions: null,
        });
        queryClient.setQueryData(projectConversationsKey(client), {
          pages: [{ items: [], nextCursor: null }],
          pageParams: [undefined],
        });
        queryClient.setQueryData(client.orpc.knowledge.list.queryKey({ input: { projectId } }), {
          embeddingModel: null,
          currentModel: null,
          models: [],
          files: [],
        });
      },
    );

    expect(html).toContain("⟦Conversations⟧");
    expect(html).toContain("⟦Knowledge⟧ 0");
  });

  it("shows no untranslated text on the keys page, with credentials on", () => {
    expectTranslated(createElement(KeySettingsPage), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
      queryClient.setQueryData(client.orpc.credentials.list.queryKey(), []);
      queryClient.setQueryData(client.orpc.settings.get.queryKey(), {
        backgroundModel: null,
        imageModel: null,
        instructions: null,
      });
      queryClient.setQueryData(client.orpc.share.list.queryKey(), []);
      queryClient.setQueryData(client.orpc.connections.list.queryKey(), { servers: [] });
      seedModels(queryClient, client);
    });
  });

  it("shows no untranslated text on a Shared link, signed out", () => {
    const html = expectTranslated(
      createElement(SharedConversationPage, {
        data: {
          token: "tok-1",
          title: "Trip planning",
          sharedAt: new Date("2026-10-01T00:00:00Z"),
          messages: [],
        },
        viewer: { signedIn: false, signInUrl: "/sign-in" },
      }),
    );

    expect(html).toContain("⟦Continue this Conversation⟧");
  });

  it("shows no untranslated text on the Shared link not-found page", () => {
    expectTranslated(createElement(SharedLinkNotFound));
  });
});
