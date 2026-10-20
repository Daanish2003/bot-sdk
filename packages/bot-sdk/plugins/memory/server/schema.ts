import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { memory, memoryOrigin } from "./db/memory";
import { memorySettings } from "./db/settings";

export * from "./db/memory";
export * from "./db/settings";

/** The `memory` plugin's schema module: Memories and the Memory switch. It adds no fields to core tables. */
export const memorySchema = {
  tables: { memory, memorySettings },
  enums: { memoryOrigin },
  // Kept empty by type: core/server/db/schema.ts spreads no memory columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
