import type { Database } from "../../core/server/db/index";
import { claimJob, runClaimedJob } from "../../core/server/jobs/store";
import { getTestDb } from "./test-database";

export type DrainJobsOptions = {
  db?: Database;
  /**
   * `false` (the default) runs every queued job now, even one in its retry backoff, so a test
   * need not move a clock. `true` runs only the jobs due at the real time, then returns.
   */
  respectRunAfter?: boolean;
};

/**
 * Runs queued jobs inline, one after another, until none are left, and returns how many ran. A
 * job that enqueues another has that one run too. A failing job is retried in the same drain, up
 * to its attempts, so the drain always ends. Failures are recorded on the row, not thrown.
 */
export async function drainJobs({
  db = getTestDb(),
  respectRunAfter = false,
}: DrainJobsOptions = {}): Promise<number> {
  const silent = { error: () => {} };
  let ran = 0;
  for (;;) {
    const claimed = await claimJob(db, new Date(), { respectRunAfter });
    if (!claimed) return ran;
    await runClaimedJob(db, claimed, { now: () => new Date(), logger: silent });
    ran += 1;
  }
}
