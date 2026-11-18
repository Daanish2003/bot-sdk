import { describe, expect, it } from "vitest";

import { checkConnections, type McpConnection } from "../src/server/connections";

const connection = (url: string): McpConnection => ({
  key: "linear",
  name: "Linear",
  mcp: { url },
});

describe("checkConnections", () => {
  it("refuses a key that isn't a plain name, and a repeated key", () => {
    const https = "https://mcp.example.com/mcp";
    expect(() => checkConnections([{ ...connection(https), key: "linear issues" }])).toThrow(
      /letters, digits/,
    );
    expect(() => checkConnections([connection(https), connection(https)])).toThrow(
      /share the key "linear"/,
    );
  });

  it("accepts an HTTPS server URL", () => {
    expect(() => checkConnections([connection("https://mcp.example.com/mcp")])).not.toThrow();
  });

  it("refuses a plain HTTP server URL on a host the test allowance does not list", () => {
    expect(() => checkConnections([connection("http://mcp.example.com/mcp")])).toThrow(/HTTPS/);
    expect(() =>
      checkConnections([connection("http://localhost:11600/mcp")], ["localhost:11534"]),
    ).toThrow(/HTTPS/);
  });

  it("accepts a plain HTTP server URL on a listed host:port", () => {
    expect(() =>
      checkConnections([connection("http://localhost:11600/mcp")], ["localhost:11600"]),
    ).not.toThrow();
  });

  it("refuses plain HTTP on a listed host's other port", () => {
    expect(() =>
      checkConnections([connection("http://localhost:11601/mcp")], ["localhost:11600"]),
    ).toThrow(/HTTPS/);
  });

  it("accepts plain HTTP on any port of a listed host without a port", () => {
    expect(() =>
      checkConnections([connection("http://localhost:11601/mcp")], ["localhost"]),
    ).not.toThrow();
  });
});

describe("checkConnections on a Connection's source", () => {
  const listIssues = {
    name: "list_issues",
    description: "Lists issues.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  };

  it("accepts a Connection whose tools the Host wrote", () => {
    expect(() =>
      checkConnections([{ key: "linear", name: "Linear", tools: [listIssues] }]),
    ).not.toThrow();
  });

  it("refuses a Host tool name that isn't a plain name, and a repeated one", () => {
    const named = (name: string) => ({ ...listIssues, name });
    expect(() =>
      checkConnections([{ key: "linear", name: "Linear", tools: [named("list issues")] }]),
    ).toThrow(
      /Connection "linear" has a tool name that isn't letters, digits, "_" or "-": "list issues"/,
    );
    expect(() =>
      checkConnections([{ key: "linear", name: "Linear", tools: [listIssues, listIssues] }]),
    ).toThrow(/Connection "linear" has two tools named "list_issues"/);
  });

  it("refuses a Connection with both an MCP server and tools the Host wrote", () => {
    const both = { ...connection("https://mcp.example.com/mcp"), tools: [listIssues] };
    expect(() => checkConnections([both as unknown as McpConnection])).toThrow(
      /Connection "linear" has both an MCP server and tools the Host wrote/,
    );
  });

  it("refuses a Connection with neither an MCP server nor tools the Host wrote", () => {
    const neither = { key: "linear", name: "Linear" };
    expect(() => checkConnections([neither as unknown as McpConnection])).toThrow(
      /Connection "linear" has neither an MCP server nor tools the Host wrote/,
    );
  });
});
