import { z } from "zod";

import { featureApi } from "../../../../core/server/feature";
import { protectedProcedure } from "../../../../core/server/procedures";
import type { McpApi } from "../plugin";

/** `mcp.disconnect`'s input, besides `userId`. */
export const disconnectInput = z.object({ key: z.string().min(1) });

/** The user's Connections to the Host's MCP servers. Tokens never leave the server (spec #91). */
export function connectionsRouter() {
  return {
    list: protectedProcedure.handler(async ({ context }) => ({
      servers: await featureApi<McpApi>(context.sdk, "mcp").listConnections({
        userId: context.user.id,
      }),
    })),

    disconnect: protectedProcedure
      .input(disconnectInput)
      .handler(({ context, input }) =>
        featureApi<McpApi>(context.sdk, "mcp").disconnect({ userId: context.user.id, ...input }),
      ),
  };
}

/** The `mcp` plugin's routers: `connections`. */
export type McpRouter = { connections: ReturnType<typeof connectionsRouter> };
