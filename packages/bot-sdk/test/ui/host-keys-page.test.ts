import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../core/client/chat-client";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../core/client/react/provider";
import { mcpClient } from "../../plugins/mcp/client/index";
import { memoryClient } from "../../plugins/memory/client/index";
import { HostKeysPage } from "./host-keys-page";

const client = createBotSdkClient({
  features: [mcpClient(), memoryClient()],
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
};

function renderKeys() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(client.orpc.models.credentials.mode.queryKey(), { byok: true });
  queryClient.setQueryData(client.orpc.models.credentials.list.queryKey(), []);
  queryClient.setQueryData(client.orpc.models.imageModel.queryKey(), { imageModel: null });
  queryClient.setQueryData(client.orpc.mcp.listConnections.queryKey(), [
    { key: "tracker", name: "E2E Tracker", state: "disconnected", scopes: [] },
  ]);
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(HostKeysPage),
    }),
  );
}

describe("the Keys page as the Host composes it", () => {
  it("shows what Bots use: keys, tool credentials, the Image Model and Connections", () => {
    const html = renderKeys();

    expect(html).toContain("Providers");
    expect(html).toContain("Tools");
    expect(html).toContain("Image Model");
    expect(html).toContain("E2E Tracker");
  });

  it("shows nothing of the assistant, and no delete-all", () => {
    const html = renderKeys();

    for (const text of [
      "Shared links",
      "Archived Conversations",
      "Instructions",
      "Saved prompts",
      "Background Model",
      "Delete all",
      "Memories",
    ]) {
      expect(html).not.toContain(text);
    }
  });
});
