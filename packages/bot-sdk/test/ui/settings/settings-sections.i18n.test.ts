import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { ConnectionsSection } from "../../../plugins/mcp/ui/connections-section";
import { renderWrapped, untranslated } from "../fake-dictionary";

/** Text the dictionary doesn't translate: the server's name and the scopes it granted. */
const ownedContent = ["GitHub", "repo"];

type Seed = (queryClient: QueryClient, client: BotSdkClient) => void;

function expectTranslated(ui: ReactElement, seed?: Seed) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, ownedContent)).toEqual([]);
  return html;
}

describe("the Bot-only settings sections with the dictionary", () => {
  it("shows no untranslated text in Connections, with a server that needs a reconnect", () => {
    const html = expectTranslated(createElement(ConnectionsSection), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.connections.list.queryKey(), {
        servers: [{ key: "github", name: "GitHub", state: "reconnect", scopes: ["repo"] }],
      });
    });
    expect(html).toContain("GitHub");
  });
});
