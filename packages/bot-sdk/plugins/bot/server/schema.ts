import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { bot } from "./db/bot";

export * from "./db/bot";

/** The `bot` plugin's schema module: its `bot` table. It adds no fields to core tables. */
export const botSchema = {
  tables: { bot },
  enums: {},
  // Kept empty by type: core/server/db/schema.ts spreads no bot columns, so adding some means adding the spread there.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
