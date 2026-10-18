import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { computer, computerState } from "./db/computer";

export * from "./db/computer";

/** The `computer` plugin's schema module: its `computer` table. It adds no fields to core tables. */
export const computerSchema = {
  tables: { computer },
  enums: { computerState },
  // Kept empty by type: core/server/db/schema.ts spreads no computer columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
