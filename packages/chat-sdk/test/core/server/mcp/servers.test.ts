import { describe, expect, it } from "vitest";

import type { AppDeps } from "../../../../core/server/deps";
import { discoverEndpoints, SignInError } from "../../../../core/server/mcp/oauth";
import { checkMcpServers, type McpServerConfig } from "../../../../core/server/mcp/servers";

const server = (url: string): McpServerConfig => ({
  key: "linear",
  name: "Linear",
  url,
  oauth: { clientId: "client", clientSecret: "secret" },
});

/** A fetch that serves the given JSON documents by URL, and 404s the rest. */
function metadataFetch(documents: Record<string, unknown>): AppDeps["fetch"] {
  return async (input) => {
    const url = new URL(new Request(input).url).href;
    const body = documents[url];
    return body === undefined ? new Response("Not found", { status: 404 }) : Response.json(body);
  };
}

describe("checkMcpServers", () => {
  it("accepts an HTTPS server URL", () => {
    expect(() => checkMcpServers([server("https://mcp.example.com/mcp")])).not.toThrow();
  });

  it("refuses a plain HTTP server URL on a host the test allowance does not list", () => {
    expect(() => checkMcpServers([server("http://mcp.example.com/mcp")])).toThrow(/HTTPS/);
    expect(() =>
      checkMcpServers([server("http://localhost:11600/mcp")], ["localhost:11534"]),
    ).toThrow(/HTTPS/);
  });

  it("accepts a plain HTTP server URL on a listed host:port", () => {
    expect(() =>
      checkMcpServers([server("http://localhost:11600/mcp")], ["localhost:11600"]),
    ).not.toThrow();
  });

  it("refuses plain HTTP on a listed host's other port", () => {
    expect(() =>
      checkMcpServers([server("http://localhost:11601/mcp")], ["localhost:11600"]),
    ).toThrow(/HTTPS/);
  });

  it("accepts plain HTTP on any port of a listed host without a port", () => {
    expect(() =>
      checkMcpServers([server("http://localhost:11601/mcp")], ["localhost"]),
    ).not.toThrow();
  });
});

describe("discoverEndpoints", () => {
  const resource = "http://localhost:11600/mcp";
  const issuerDocs = (authorizationEndpoint: string) => ({
    "http://localhost:11600/.well-known/oauth-protected-resource": {
      authorization_servers: ["http://localhost:11600"],
    },
    "http://localhost:11600/.well-known/oauth-authorization-server": {
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: "http://localhost:11600/token",
    },
  });

  it("takes plain HTTP endpoints of a listed host", async () => {
    const endpoints = await discoverEndpoints(
      server(resource),
      metadataFetch(issuerDocs("http://localhost:11600/authorize")),
      ["localhost:11600"],
    );

    expect(endpoints).toEqual({
      authorizationEndpoint: "http://localhost:11600/authorize",
      tokenEndpoint: "http://localhost:11600/token",
    });
  });

  it("refuses plain HTTP endpoints when the host is not listed", async () => {
    await expect(
      discoverEndpoints(
        server(resource),
        metadataFetch(issuerDocs("http://localhost:11600/authorize")),
        [],
      ),
    ).rejects.toBeInstanceOf(SignInError);
  });
});
