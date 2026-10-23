import type { AnyServerTool } from "@tanstack/ai";
import { eq } from "drizzle-orm";

import { mcpConnection } from "../../../core/server/db/schema";
import type { BotSdkPlugin, Route } from "../../../core/server/plugin";
import { rotateConnectionKeys } from "./connections";
import { callbackRoute, connectRoute } from "./routes";
import { connectionsRouter, type McpRouter } from "./routers/index";
import { checkMcpServers, type McpServerConfig } from "./servers";
import { openMcpTools } from "./tools";

export type McpOptions = {
  /**
   * Remote MCP servers the users may connect to (spec #91). Streamable HTTP over HTTPS only. Each
   * server needs an OAuth client the Host registered with it ahead of time; the README says which
   * redirect URI to register.
   */
  servers?: McpServerConfig[];
};

/** The `mcp` plugin's API (`sdk.plugin("mcp")`): a user's Connections as tools. */
export type McpApi = {
  forUser: (userId: string) => {
    /**
     * The tools of the user's connected servers, named `<server key>_<tool>`, with their clients
     * open until `signal` aborts. Expired tokens are refreshed first; a server that is down or whose
     * Connection needs reconnecting is skipped.
     */
    tools: (options: { signal: AbortSignal }) => Promise<AnyServerTool[]>;
  };
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    mcp: McpApi;
  }
}

export type McpPlugin = BotSdkPlugin<"mcp", never, never>;

/**
 * The `mcp` plugin (ADR 0027): the Host's MCP servers, the users' Connections to them (the sign-in
 * routes, the `connections` router and key rotation) and their tools.
 */
export function mcp(options: McpOptions = {}): McpPlugin {
  const servers = options.servers ?? [];
  return {
    id: "mcp",
    router: { connections: connectionsRouter(servers) } satisfies McpRouter,
    routes: mcpRoutes(servers),
    init: (sdk) => {
      // At construction, so a misconfigured server fails the Host's boot (spec #91).
      checkMcpServers(servers, sdk.fetchAllowHosts);
      const api: McpApi = {
        forUser: (userId) => ({
          tools: ({ signal }) => openMcpTools(sdk, servers, userId, signal),
        }),
      };
      return { api };
    },
    deleteUser: {
      before: async (_sdk, { userId, tx }) => {
        await tx.delete(mcpConnection).where(eq(mcpConnection.userId, userId));
      },
      after: async () => {},
    },
    rotateKeys: async (sdk) => {
      const { reencrypted, unreadable } = await rotateConnectionKeys(sdk);
      if (unreadable > 0) {
        sdk.logger.error("Stored MCP tokens can't be read; left in place", { unreadable });
      }
      return { reencrypted, unreadable };
    },
  };
}

/** The sign-in routes, under `basePath`: `/mcp/connect` starts one and `/mcp/callback` ends it. */
function mcpRoutes(servers: readonly McpServerConfig[]): Route[] {
  return (["connect", "callback"] as const).map((step): Route => ({
    method: "GET",
    path: `/mcp/${step}`,
    handle: (request, { user, sdk, basePath }) => {
      const redirectUri = `${new URL(request.url).origin}${basePath}/mcp/callback`;
      const route = step === "connect" ? connectRoute : callbackRoute;
      return route(request, user.id, sdk, servers, redirectUri);
    },
  }));
}
