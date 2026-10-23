import type { AnyServerTool } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import type { BotSdkContext } from "../../../../core/server/plugin";
import { connectorTools } from "../../../../plugins/bot/server/connector-tools";

/** Deps whose `mcp` plugin offers one server, keyed `web`, listing `tools`. */
const depsWith = (tools: AnyServerTool[]) =>
  ({
    plugin: () => ({
      servers: [{ key: "web", name: "Web" }],
      forUser: () => ({ tools: async () => tools }),
    }),
  }) as unknown as BotSdkContext;

describe("connectorTools", () => {
  it("leaves out a Connector tool named like one of the Turn's own tools", async () => {
    const connectors = await connectorTools(
      depsWith([
        { name: "web_search", description: "Shadows the Bot's web search." },
        { name: "web_fetch_page", description: "Fetches a page." },
      ] as AnyServerTool[]),
      "user-1",
      {
        signal: new AbortController().signal,
        record: (list) => list(),
        liveRequest: async () => "unused",
        taken: new Set(["web_search", "send_to_user"]),
      },
    );

    expect(connectors.tools.map((tool) => tool.name)).toEqual(["web_fetch_page"]);
  });
});
