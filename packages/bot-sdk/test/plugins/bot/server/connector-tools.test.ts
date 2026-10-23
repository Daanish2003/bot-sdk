import type { AnyServerTool } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import type { BotSdkContext } from "../../../../core/server/plugin";
import {
  type ConnectorListing,
  connectorTools,
  reconnectError,
} from "../../../../plugins/bot/server/connector-tools";

/** Deps whose `mcp` plugin offers one server, keyed `web`, listing `tools`, and the user no Secrets. */
const depsWith = (tools: AnyServerTool[]) =>
  ({
    plugin: () => ({
      servers: [{ key: "web", name: "Web" }],
      forUser: () => ({ tools: async () => tools }),
    }),
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  }) as unknown as BotSdkContext;

/**
 * The Connector tools over `live`, as a Turn whose recorded listing is `recorded` (a replay) or the
 * live one, each call run at once.
 */
const connectorsOf = (live: AnyServerTool[], recorded?: ConnectorListing[]) =>
  connectorTools(depsWith(live), "user-1", {
    signal: new AbortController().signal,
    record: async (list) => recorded ?? list(),
    liveRequest: async (_name, _id, run) => run(),
    taken: new Set(),
  });

const listing = (name: string): ConnectorListing => ({
  name,
  description: `The ${name} tool.`,
  reviewed: false,
});

/** The result of calling `name` among `connectors`' tools. */
async function call(connectors: Awaited<ReturnType<typeof connectorsOf>>, name: string) {
  const tool = connectors.tools.find((each) => each.name === name);
  return (await tool?.execute?.({}, { toolCallId: "call-1" })) as unknown;
}

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

  it("answers a tool's own TypeError as the call's error, fenced, not as a dropped Connection", async () => {
    const connectors = await connectorsOf([
      {
        name: "web_fetch_page",
        description: "Fetches a page.",
        execute: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'content')");
        },
      },
    ] as AnyServerTool[]);

    const result = await call(connectors, "web_fetch_page");

    expect(result).toEqual({
      error: expect.stringContaining("Cannot read properties of undefined"),
    });
    expect(JSON.stringify(result)).not.toContain("needs reconnecting");
  });

  it("answers a call whose fetch failed on the network that its Connection needs reconnecting", async () => {
    const connectors = await connectorsOf([
      {
        name: "web_fetch_page",
        description: "Fetches a page.",
        execute: async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        },
      },
    ] as AnyServerTool[]);

    expect(await call(connectors, "web_fetch_page")).toEqual({ error: reconnectError("Web") });
  });

  it("answers a replayed call to a tool its live, listed server no longer offers as unknown", async () => {
    const connectors = await connectorsOf(
      [
        { name: "web_fetch_page", description: "Fetches a page.", execute: async () => "ok" },
      ] as AnyServerTool[],
      [listing("web_fetch_page"), listing("web_crawl")],
    );

    const result = await call(connectors, "web_crawl");

    expect(result).toEqual({ error: "Connection Web no longer offers the tool web_crawl." });
  });

  it("answers a replayed call to a tool of a server with no live tools that it needs reconnecting", async () => {
    const connectors = await connectorsOf([], [listing("web_crawl")]);

    expect(await call(connectors, "web_crawl")).toEqual({ error: reconnectError("Web") });
  });
});
