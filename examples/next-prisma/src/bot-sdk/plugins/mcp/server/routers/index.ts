import { z } from "zod";

import { deleteConnection, listConnections } from "../connections";
import type { McpServerConfig } from "../servers";
import { protectedProcedure } from "../../../../core/server/procedures";

/** The user's Connections to the Host's MCP servers. Tokens never leave the server (spec #91). */
export function connectionsRouter(servers: readonly McpServerConfig[]) {
  return {
    list: protectedProcedure.handler(async ({ context }) => ({
      servers: await listConnections(context.sdk, servers, context.user.id),
    })),

    disconnect: protectedProcedure
      .input(z.object({ key: z.string().min(1) }))
      .handler(({ context, input }) => deleteConnection(context.sdk, context.user.id, input.key)),
  };
}

/** The `mcp` plugin's routers: `connections`. */
export type McpRouter = { connections: ReturnType<typeof connectionsRouter> };
