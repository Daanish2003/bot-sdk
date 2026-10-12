import { describe, expect, it } from "vitest";

import { mcpServersOf } from "./mcp-server";

const set = {
  MCP_SERVER_KEY: "issues",
  MCP_SERVER_NAME: "Issue tracker",
  MCP_SERVER_URL: "https://mcp.example.com/mcp",
  MCP_SERVER_OAUTH_CLIENT_ID: "chat-client",
  MCP_SERVER_OAUTH_CLIENT_SECRET: "chat-secret",
};

describe("mcpServersOf", () => {
  it("offers no MCP server when none of the MCP_SERVER variables is set", () => {
    expect(mcpServersOf({})).toEqual([]);
    expect(mcpServersOf({ MCP_SERVER_KEY: "", MCP_SERVER_URL: undefined })).toEqual([]);
  });

  it("offers the one server the variables describe", () => {
    expect(mcpServersOf(set)).toEqual([
      {
        key: "issues",
        name: "Issue tracker",
        url: "https://mcp.example.com/mcp",
        oauth: { clientId: "chat-client", clientSecret: "chat-secret" },
      },
    ]);
  });

  it("refuses a partly set server, naming what is missing", () => {
    const { MCP_SERVER_OAUTH_CLIENT_SECRET: _secret, ...partial } = set;

    expect(() => mcpServersOf(partial)).toThrow(/MCP_SERVER_OAUTH_CLIENT_SECRET/);
  });
});
