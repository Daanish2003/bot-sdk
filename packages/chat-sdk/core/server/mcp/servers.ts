import { isAllowListed } from "../lib/guarded-fetch";

/**
 * One remote MCP server a Host offers (`createChat({ mcpServers })`, spec #91). The Host is the
 * operator: a user can only sign in to the servers listed here.
 */
export type McpServerConfig = {
  /** Names the server in storage and in its Connection. Letters, digits, `_` and `-`. */
  key: string;
  name: string;
  /** The server's Streamable HTTP endpoint. HTTPS only. */
  url: string;
  /** The OAuth client the Host registered with the server ahead of time (no Dynamic Client Registration). */
  oauth: { clientId: string; clientSecret: string };
  /** Tool names to offer from this server. Accepted now; nothing reads it until MCP tools in a Run land. */
  tools?: string[];
  /** Tool names that run without Approval. Accepted now; nothing reads it until MCP tools in a Run land. */
  approvalFree?: string[];
};

const keyPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Throws on a server the SDK can't offer: a key that isn't a plain name, a repeated key, or a URL
 * that isn't HTTPS. The test allowance (`allowHosts`, `createChat({ fetchAllowHosts })`) lets a
 * listed host be plain HTTP, and only that host.
 */
export function checkMcpServers(
  servers: readonly McpServerConfig[],
  allowHosts: readonly string[] = [],
): void {
  const keys = new Set<string>();
  for (const server of servers) {
    if (!keyPattern.test(server.key)) {
      throw new Error(`An MCP server key must be letters, digits, "_" or "-": "${server.key}"`);
    }
    if (keys.has(server.key)) throw new Error(`Two MCP servers share the key "${server.key}"`);
    keys.add(server.key);
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error(`MCP server "${server.key}" has no valid URL`);
    }
    const plainHttpAllowed = url.protocol === "http:" && isAllowListed(url, allowHosts);
    if (url.protocol !== "https:" && !plainHttpAllowed) {
      throw new Error(`MCP server "${server.key}" must use an HTTPS URL, got ${server.url}`);
    }
  }
}
