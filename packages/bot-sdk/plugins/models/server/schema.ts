import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { userCredentials } from "./db/credentials";
import { usage, usageKind } from "./db/usage";

export * from "./db/credentials";
export * from "./db/usage";

/** The `models` plugin's schema module: its credentials and usage tables. It adds no fields to core tables. */
export const modelsSchema = {
  tables: { userCredentials, usage },
  enums: { usageKind },
  // Kept empty by type: core/server/db/schema.ts spreads no models columns, so adding some means adding the spread there.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
