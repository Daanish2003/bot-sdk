import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { ConnectionsSection } from "../../../plugins/mcp/ui/connections-section";
import { DeleteAllConversationsSection } from "../../../plugins/assistant/ui/settings/delete-all-conversations";
import { ExportDataButton } from "../../../ui/settings/export-data-button";
import { InstructionsField } from "../../../plugins/assistant/ui/settings/instructions-field";
import { SharedLinksSection } from "../../../plugins/assistant/ui/settings/shared-links";
import { BackgroundModelSelect } from "../../../plugins/assistant/ui/settings/background-model-select";
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

/** Text the dictionary doesn't translate: Model and Provider names, and the user's own data. */
const ownedContent = ["Claude Haiku 4.5", "Anthropic", "Trip planning", "GitHub", "repo"];

function seedSettings(
  queryClient: QueryClient,
  client: BotSdkClient,
  backgroundModel: string | null,
) {
  queryClient.setQueryData(client.orpc.settings.get.queryKey(), {
    backgroundModel,
    instructions: null,
  });
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [model],
    defaultModel: null,
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: false,
  });
}

type Seed = (queryClient: QueryClient, client: BotSdkClient) => void;

function expectTranslated(ui: ReactElement, seed?: Seed) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, ownedContent)).toEqual([]);
  return html;
}

describe("the settings sections with the dictionary", () => {
  it("shows no untranslated text in Instructions", () => {
    expectTranslated(createElement(InstructionsField), (queryClient, client) =>
      seedSettings(queryClient, client, null),
    );
  });

  it("shows no untranslated text in Titles, with a saved Background Model", () => {
    expectTranslated(createElement(BackgroundModelSelect), (queryClient, client) =>
      seedSettings(queryClient, client, model.id),
    );
  });

  it("shows no untranslated text in Shared links, with one link", () => {
    expectTranslated(createElement(SharedLinksSection), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.share.list.queryKey(), [
        {
          token: "tok-1",
          conversationId: "c1",
          title: "Trip planning",
          sharedAt: new Date(),
        },
      ]);
    });
  });

  it("shows no untranslated text in Shared links, with none", () => {
    const html = expectTranslated(createElement(SharedLinksSection), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.share.list.queryKey(), []);
    });
    expect(html).toContain("shared any Conversations.⟧");
  });

  it("shows no untranslated text in Connections, with a server that needs a reconnect", () => {
    expectTranslated(createElement(ConnectionsSection), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.connections.list.queryKey(), {
        servers: [{ key: "github", name: "GitHub", state: "reconnect", scopes: ["repo"] }],
      });
    });
  });

  it("shows no untranslated text in Delete all, and Export data", () => {
    expectTranslated(createElement(DeleteAllConversationsSection));
    expectTranslated(createElement(ExportDataButton));
  });
});
