import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../../core/client/chat-client";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../core/client/react/provider";
import { KeySettingsPage } from "../../ui/pages/key-settings";

const client = createChatClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

/** Renders the keys page with `byok` on and the Connections list seeded as `servers`. */
function renderKeys(
  servers: Array<{
    key: string;
    name: string;
    state: "connected" | "reconnect" | "disconnected";
    scopes: string[];
  }>,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
  queryClient.setQueryData(client.orpc.credentials.list.queryKey(), []);
  queryClient.setQueryData(client.orpc.connections.list.queryKey(), { servers });
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(KeySettingsPage),
    }),
  );
}

describe("the Connections section of the keys page", () => {
  it("is left out when the Host lists no MCP servers", () => {
    expect(renderKeys([])).not.toContain("Connections");
  });

  it("offers Connect for a server the user isn't connected to", () => {
    const html = renderKeys([{ key: "linear", name: "Linear", state: "disconnected", scopes: [] }]);

    expect(html).toContain("Connections");
    expect(html).toContain("Linear");
    expect(html).toContain("Connect");
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain("Reconnect");
  });

  it("offers Disconnect and the granted scopes for a connected server", () => {
    const html = renderKeys([
      { key: "linear", name: "Linear", state: "connected", scopes: ["read:issues"] },
    ]);

    expect(html).toContain("Disconnect");
    expect(html).toContain("read:issues");
  });

  it("offers Reconnect and Disconnect for a server whose sign-in needs renewing", () => {
    const html = renderKeys([{ key: "linear", name: "Linear", state: "reconnect", scopes: [] }]);

    expect(html).toContain("Reconnect needed");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Disconnect");
  });
});
