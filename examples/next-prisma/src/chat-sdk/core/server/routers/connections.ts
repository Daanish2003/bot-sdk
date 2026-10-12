import { z } from "zod";

import { deleteConnection, listConnections } from "../mcp/connections";
import { protectedProcedure } from "../procedures";

/** The user's Connections to the Host's MCP servers. Tokens never leave the server (spec #91). */
export const connectionsRouter = {
  list: protectedProcedure.handler(async ({ context }) => ({
    servers: await listConnections(context.deps, context.user.id),
  })),

  disconnect: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .handler(({ context, input }) => deleteConnection(context.deps, context.user.id, input.key)),
};
