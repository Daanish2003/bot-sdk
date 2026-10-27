import type { AnyServerTool } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import { defineFeature } from "@botsdk/bot/feature";
import type { Route } from "@botsdk/bot/plugin";
import { parseInput } from "@botsdk/bot/rpc-error";
import {
  deleteConnection,
  listConnections,
  rotateConnectionKeys,
  type ConnectionSummary,
} from "./connections";
import { connectorTools } from "./connector-tools";
import { mcpConnection } from "./db/connection";
import mcpMigrations from "./migrations.json" with { type: "json" };
import { callbackRoute, connectRoute } from "./routes";
import { disconnectInput, mcpContract } from "../shared/contract";
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

/** The `mcp` feature's API (`sdk.mcp`): a user's Connections as tools. */
export type McpApi = {
  /** The user's Connection to each of the Host's servers, in the Host's order (spec #873). */
  listConnections: (input: { userId: string }) => Promise<ConnectionSummary[]>;
  /** Removes the user's Connection to one server: its tokens and any sign-in in flight. */
  disconnect: (input: { userId: string } & z.input<typeof disconnectInput>) => Promise<void>;
  /** The servers the Host offers, by key and name: what a tool named `<key>_<tool>` belongs to. */
  servers: ReadonlyArray<{ key: string; name: string }>;
  forUser: (userId: string) => {
    /**
     * The tools of the user's connected servers, named `<server key>_<tool>`, with their clients
     * open until `signal` aborts. Expired tokens are refreshed first; a server that is down or whose
     * Connection needs reconnecting is skipped.
     */
    tools: (options: { signal: AbortSignal }) => Promise<AnyServerTool[]>;
  };
};

/**
 * The `mcp` feature (ADR 0027, spec #871): the Host's MCP servers, the users' Connections to them
 * (the sign-in routes, the `mcp` contract and key rotation) and their tools. A Host turns it
 * on with `mcp({ servers })` in `features`.
 */
export function mcp(options: McpOptions = {}) {
  const servers = options.servers ?? [];
  return defineFeature({
    id: "mcp",
    schema: { tables: { mcpConnection }, migrations: mcpMigrations },
    connectorTools: true,
    contract: mcpContract,
    routes: mcpRoutes(servers),
    api: (context): McpApi => {
      // At construction, so a misconfigured server fails the Host's boot (spec #91).
      checkMcpServers(servers, context.fetchAllowHosts);
      return {
        listConnections: ({ userId }) => listConnections(context, servers, userId),
        disconnect: async ({ userId, ...rest }) => {
          await deleteConnection(context, userId, parseInput(disconnectInput, rest).key);
        },
        servers: servers.map(({ key, name }) => ({ key, name })),
        forUser: (userId) => ({
          tools: ({ signal }) => openMcpTools(context, servers, userId, signal),
        }),
      };
    },
    // Listed by a Turn, never when only the definitions are read: the next Turn notes them added.
    tools: async (turn, context, kit) => {
      if (!kit) return [];
      return connectorTools({
        servers,
        open: (signal) => openMcpTools(context, servers, turn.userId, signal),
        ...kit,
      });
    },
    userData: {
      delete: {
        before: async (tx, userId) => {
          await tx.delete(mcpConnection).where(eq(mcpConnection.userId, userId));
        },
      },
    },
    rotateKeys: async (context) => {
      const { reencrypted, unreadable } = await rotateConnectionKeys(context);
      if (unreadable > 0) {
        context.logger.error("Stored MCP tokens can't be read; left in place", { unreadable });
      }
      return { reencrypted, unreadable };
    },
  });
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
