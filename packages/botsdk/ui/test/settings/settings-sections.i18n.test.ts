import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ConnectionsSection } from "../../src/mcp/connections-section";
import { RulesPage } from "../../src/settings/rules-page";
import { ExportDataButton } from "../../src/settings/export-data-button";
import {
  renderWrapped,
  untranslated,
  type TestClient,
} from "@ai-chat/test-support/fake-dictionary";

/** Text the dictionary doesn't translate: the server's name and the scopes it granted. */
const ownedContent = ["GitHub", "repo", "Reply to emails from anyone @acme.com"];

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

  it("shows no untranslated text in Rules, with a rule written", () => {
    const at = new Date("2026-10-29T09:00:00.000Z");
    const html = expectTranslated(createElement(RulesPage), (queryClient, client) => {
      queryClient.setQueryData(client.orpc.rules.list.queryKey(), [
        {
          id: "00000000-0000-4000-8000-000000000001",
          text: "Reply to emails from anyone @acme.com",
          mode: "hand_off",
          state: "active",
          proposedByBotId: null,
          createdAt: at,
          updatedAt: at,
        },
      ]);
    });
    expect(html).toContain("Reply to emails from anyone @acme.com");
  });

  it("shows no untranslated text in Export data", () => {
    expectTranslated(createElement(ExportDataButton));
  });
});
