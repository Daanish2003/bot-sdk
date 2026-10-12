import type { AnyServerTool } from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";

import type { ConversationTools } from "../../shared/chat/conversation-tools";
import { allowTools } from "../chat/host-tools";
import type { AppDeps } from "../deps";
import { isExpired, readTokens, saveTokens } from "./connections";
import { discoverEndpoints, refreshAccess } from "./oauth";
import type { McpServerConfig } from "./servers";

/**
 * The MCP tools a Run offers (spec #91): one client per Connection switched on in the
 * Conversation, opened when the Run starts and closed when it ends.
 */
type Deps = Pick<
  AppDeps,
  "db" | "keyEncryptionSecrets" | "mcpServers" | "fetch" | "fetchAllowHosts"
>;

export type McpTools = { tools: AnyServerTool[]; close: () => Promise<void> };

/**
 * The access token to call a server with: the stored one, or a refreshed one when it has expired.
 * `null` when there is none, so the server's tools are not offered. A refresh the server refuses
 * drops the refresh token, which leaves the Connection needing reconnection (`listConnections`).
 */
async function accessTokenFor(deps: Deps, userId: string, server: McpServerConfig) {
  const stored = await readTokens(deps, userId, server.key);
  if (!stored) return null;
  const { tokens, scope } = stored;
  if (!isExpired(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  try {
    const { tokenEndpoint } = await discoverEndpoints(server, deps.fetch, deps.fetchAllowHosts);
    const refreshed = await refreshAccess({
      fetch: deps.fetch,
      server,
      tokenEndpoint,
      refreshToken: tokens.refreshToken,
      scope,
    });
    await saveTokens(deps, userId, server.key, refreshed);
    return refreshed.accessToken;
  } catch {
    await saveTokens(deps, userId, server.key, {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      scope,
    });
    return null;
  }
}

/**
 * Opens the MCP tools of the switched-on servers. A server that is down, or whose Connection can't
 * be used, offers no tools and the Run goes on without them. Each tool is named under its server's
 * key, filtered by the server's `tools` allowlist, and needs Approval unless `approvalFree` lists it.
 */
export async function openMcpTools(deps: Deps, userId: string, keys: string[]): Promise<McpTools> {
  const tools: AnyServerTool[] = [];
  const clients: Array<{ close: () => Promise<void> }> = [];
  for (const server of deps.mcpServers) {
    if (!keys.includes(server.key)) continue;
    try {
      const accessToken = await accessTokenFor(deps, userId, server);
      if (!accessToken) continue;
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: server.url,
          headers: { authorization: `Bearer ${accessToken}` },
          fetch: deps.fetch,
        },
        name: "ai-chat",
        prefix: server.key,
        toolFilter: (tool) => !server.tools || server.tools.includes(tool.name),
        needsApproval: (tool) => !(server.approvalFree ?? []).includes(tool.name),
      });
      clients.push(client);
      tools.push(...((await client.tools()) as AnyServerTool[]));
    } catch {
      // The server is down or refused the call: its tools are left out of this Run.
    }
  }
  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    },
  };
}

/**
 * The MCP tools for the Conversation's switched-on `connections`, opened before a reply's history is
 * built, since the history depends on which tools the reply offers. `undefined` when none is
 * switched on, so no client is opened (spec #91). The caller closes what it opens. A tool the
 * Conversation allows runs without Approval (#159).
 */
export async function mcpToolsFor(
  deps: Deps,
  userId: string,
  settings: ConversationTools,
): Promise<McpTools | undefined> {
  const keys = settings.connections.filter((key) =>
    deps.mcpServers.some((server) => server.key === key),
  );
  if (keys.length === 0) return undefined;
  const opened = await openMcpTools(deps, userId, keys);
  return { ...opened, tools: allowTools(opened.tools, settings.allowedTools) };
}
