import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { job, jobEvent, jobStatus } from "./db/job";

export * from "./db/job";

/** The `runner` plugin's schema module: its `job` table and the jobs' history, `job_event`. It adds no fields to core tables. */
export const runnerSchema = {
  tables: { job, jobEvent },
  enums: { jobStatus },
  // Kept empty by type: core/server/db/schema.ts spreads no runner columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
