import type { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import type { ChatClient } from "../../../core/client/chat-client";
import type { ListedModel } from "../../../core/shared/chat/models";
import { AppShell } from "../../../ui/shell/app-shell";
import { ConversationMenuItems, TopBar } from "../../../ui/shell/top-bar";
import { renderWrapped, untranslated } from "../fake-dictionary";

const conversation = {
  id: "c1",
  title: "Trip planning",
  model: "anthropic:claude-haiku-4-5",
  lastMessageAt: new Date(),
  preview: "Where to next",
  pinnedAt: null,
  projectId: null,
  shared: false,
  hasError: false,
};

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

const modelsList = (models: ListedModel[]) => ({
  models,
  defaultModel: null,
  defaultBackgroundModel: null,
  imageModels: [],
  defaultImageModel: null,
  webSearchOnHost: false,
});

/** Seeds the shell's lists: a Conversation (in the panel and pinned), a Project and a Model. */
function seedShell(queryClient: QueryClient, client: ChatClient) {
  queryClient.setQueryData(client.orpc.models.list.queryKey(), modelsList([model]));
  queryClient.setQueryData(client.orpc.conversation.pinned.queryKey(), [conversation]);
  queryClient.setQueryData(client.orpc.project.list.queryKey(), {
    items: [{ id: "p1", name: "Thesis" }],
  });
  queryClient.setQueryData(conversationListKey(client), {
    pages: [{ items: [conversation], nextCursor: null }],
    pageParams: [undefined],
  });
}

function conversationListKey(client: ChatClient) {
  return client.orpc.conversation.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ cursor }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  }).queryKey;
}

/**
 * Text the dictionary doesn't translate: the user's own content, the Model and Provider names the
 * core owns, the brand, and the test's child content.
 */
const userContent = [
  "Trip planning",
  "Where to next",
  "Thesis",
  "Claude Haiku 4.5",
  "Anthropic",
  "page",
  "ai",
];

describe("the shell with the dictionary", () => {
  it("shows no untranslated text in the rail, the Conversation panel and the top bar", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }), { seed: seedShell });

    expect(untranslated(html, userContent)).toEqual([]);
  });

  it("shows no untranslated text on a new Conversation, with its Model picker", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }), {
      seed: seedShell,
      location: { newConversation: true, newConversationModel: model.id },
    });

    expect(untranslated(html, userContent)).toEqual([]);
  });

  it("shows the empty states and the add-credentials prompt through the dictionary", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }), {
      seed: (queryClient, client) => {
        queryClient.setQueryData(client.orpc.models.list.queryKey(), modelsList([]));
        queryClient.setQueryData(client.orpc.conversation.pinned.queryKey(), []);
        queryClient.setQueryData(client.orpc.project.list.queryKey(), { items: [] });
        queryClient.setQueryData(conversationListKey(client), {
          pages: [{ items: [], nextCursor: null }],
          pageParams: [undefined],
        });
      },
    });

    expect(html).toContain("⟦No Conversations yet⟧");
    expect(html).toContain("⟦Add Provider credentials to start⟧");
    expect(untranslated(html, userContent)).toEqual([]);
  });

  it("shows no untranslated text in the top bar of an open Conversation, with its Conversation menu", () => {
    const html = renderWrapped(
      createElement(TopBar, {
        panelOpen: true,
        drawerOpen: false,
        onOpenPanel: () => {},
        onOpenDrawer: () => {},
        onOpenSearch: () => {},
      }),
      { location: { conversationId: conversation.id } },
    );

    expect(html).toContain("⟦Conversation menu⟧");
    expect(untranslated(html, userContent)).toEqual([]);
  });

  it("shows no untranslated text in the Conversation menu's items", () => {
    const html = renderWrapped(
      createElement(ConversationMenuItems, { onExport: () => {}, onPrint: () => {} }),
    );

    expect(html).toContain("⟦Export as Markdown⟧");
    expect(html).toContain("⟦Print / Save as PDF⟧");
    expect(untranslated(html)).toEqual([]);
  });
});
