import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { job, jobStatus } from "./db/job";

export * from "./db/job";

/** The `runner` plugin's schema module: its `job` table. It adds no fields to core tables. */
export const runnerSchema = {
  tables: { job },
  enums: { jobStatus },
  // Kept empty by type: core/server/db/schema.ts spreads no runner columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
