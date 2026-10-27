import type { PluginSchema } from "../plugin-schema";
import { job, jobEvent, jobStatus } from "./job";

export * from "./job";

/** The `runner` plugin's schema module: its `job` table and the jobs' history, `job_event`. */
export const runnerSchema = {
  tables: { job, jobEvent },
  enums: { jobStatus },
} satisfies PluginSchema;
