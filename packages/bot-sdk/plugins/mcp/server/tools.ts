import type { AnyServerTool } from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";

import type { BotSdkContext } from "../../../core/server/plugin";
import { isExpired, readTokens, saveTokens } from "./connections";
import { discoverEndpoints, refreshAccess } from "./oauth";
import type { McpServerConfig } from "./servers";

type Deps = Pick<BotSdkContext, "db" | "keyring" | "fetch" | "fetchAllowHosts">;

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
 * The tools of the user's connected servers, one client per Connection, open until `signal`
 * aborts. The servers are opened side by side, so a slow one holds up no other. A server that is
 * down, or whose Connection can't be used, is skipped. Each tool is named `<server key>_<tool>`,
 * filtered by the server's `tools` allowlist, and needs approval unless the server's `approvalFree`
 * lists it.
 */
export async function openMcpTools(
  deps: Deps,
  servers: readonly McpServerConfig[],
  userId: string,
  signal: AbortSignal,
): Promise<AnyServerTool[]> {
  if (signal.aborted) return [];
  const clients: Array<{ close: () => Promise<void> }> = [];
  const closeAll = () => {
    for (const client of clients.splice(0)) void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeAll, { once: true });

  const opened = await Promise.all(
    servers.map(async (server): Promise<AnyServerTool[]> => {
      const accessToken = await accessTokenFor(deps, userId, server).catch(() => null);
      if (!accessToken || signal.aborted) return [];
      let client: { close: () => Promise<void>; tools: () => Promise<unknown> } | undefined;
      try {
        client = await createMCPClient({
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
        if (signal.aborted) throw signal.reason;
        const tools = (await client.tools()) as AnyServerTool[];
        clients.push(client);
        // A client opened as the signal aborted is closed at once.
        if (signal.aborted) closeAll();
        return tools;
      } catch {
        // The server is down or refused the call: its tools are left out and its client closed.
        void client?.close().catch(() => undefined);
        return [];
      }
    }),
  );
  // With no client left open, the signal has nothing to close.
  if (clients.length === 0) signal.removeEventListener("abort", closeAll);
  return signal.aborted ? [] : opened.flat();
}
