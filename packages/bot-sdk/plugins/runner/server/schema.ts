import type { PluginSchema } from "../../../core/server/db/plugin-schema";
import { job, jobEvent, jobStatus } from "./db/job";

export * from "./db/job";

/** The `runner` plugin's schema module: its `job` table and the jobs' history, `job_event`. */
export const runnerSchema = {
  tables: { job, jobEvent },
  enums: { jobStatus },
} satisfies PluginSchema;
