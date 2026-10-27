import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ConnectionsSection } from "@botsdk/ui/mcp/connections-section";
import { ExportDataButton } from "@botsdk/ui/settings/export-data-button";
import { renderWrapped, untranslated, type TestClient } from "../fake-dictionary";

/** Text the dictionary doesn't translate: the server's name and the scopes it granted. */
const ownedContent = ["GitHub", "repo"];

type Seed = (queryClient: QueryClient, client: TestClient) => void;

function expectTranslated(ui: ReactElement, seed?: Seed) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, ownedContent)).toEqual([]);
  return html;
}

describe("the Bot-only settings sections with the dictionary", () => {
  it("shows no untranslated text in Connections, with a server that needs a reconnect", () => {
    const html = expectTranslated(createElement(ConnectionsSection), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.mcp.listConnections.queryKey(), [
        { key: "github", name: "GitHub", state: "reconnect", scopes: ["repo"] },
      ]);
    });
    expect(html).toContain("GitHub");
  });

  it("shows no untranslated text in Export data", () => {
    expectTranslated(createElement(ExportDataButton));
  });
});
