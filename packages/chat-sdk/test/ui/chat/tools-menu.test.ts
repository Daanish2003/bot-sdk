import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { mcpToolsMenu, switchConnection } from "../../../core/client/mcp-tools";
import { ToolsMenu, ToolsMenuList } from "../../../ui/chat/tools-menu";

const servers = [
  { key: "linear", name: "Linear", state: "connected" as const },
  { key: "github", name: "GitHub", state: "disconnected" as const },
  { key: "notion", name: "Notion", state: "reconnect" as const },
  { key: "sentry", name: "Sentry", state: "connected" as const },
];

describe("the tools menu", () => {
  it("lists only the servers the user is connected to, each off by default", () => {
    expect(mcpToolsMenu(servers, [])).toEqual([
      { key: "linear", name: "Linear", on: false },
      { key: "sentry", name: "Sentry", on: false },
    ]);
  });

  it("shows a server on when the Conversation has it switched on", () => {
    expect(mcpToolsMenu(servers, ["sentry"]).map((item) => item.on)).toEqual([false, true]);
  });

  it("lists nothing when the Host lists no servers", () => {
    expect(mcpToolsMenu([], [])).toEqual([]);
    expect(renderToStaticMarkup(createElement(ToolsMenu, { items: [], onToggle: () => {} }))).toBe(
      "",
    );
  });

  it("renders one switch per connected server, off by default", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolsMenuList, {
        items: mcpToolsMenu(servers, []),
        onToggle: () => {},
      }),
    );

    expect(markup).toContain("Linear");
    expect(markup).toContain("Sentry");
    expect(markup).not.toContain("GitHub");
    expect(markup).not.toContain("Notion");
    expect(markup.match(/aria-checked="false"/g)).toHaveLength(2);
  });

  it("switches a server on and off, keeping the others", () => {
    expect(switchConnection([], "linear", true)).toEqual(["linear"]);
    expect(switchConnection(["linear", "sentry"], "linear", false)).toEqual(["sentry"]);
    expect(switchConnection(["linear"], "linear", true)).toEqual(["linear"]);
  });
});
