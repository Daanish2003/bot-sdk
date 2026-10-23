import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { mcpConnection } from "./db/connection";

export * from "./db/connection";

/** The `mcp` plugin's schema module: the users' Connections. It adds no fields to core tables. */
export const mcpSchema = {
  tables: { mcpConnection },
  enums: {},
  // Kept empty by type: core/server/db/schema.ts spreads no mcp columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
