import type { AppDeps } from "../../core/server/deps";
import type { Database } from "../../core/server/db/index";
import { systemClock } from "../../core/server/jobs/in-process";
import { claimJob, runClaimedJob } from "../../core/server/jobs/store";
import { createTestDeps } from "./deps";
import { getTestDb } from "./test-database";

export type DrainJobsOptions = {
  db?: Database;
  /**
   * The dependencies the jobs run with. A test that drains a job which calls models passes the
   * deps its Run used, so the fakes are the same. Defaults to fresh test deps.
   */
  deps?: AppDeps;
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
  deps,
}: DrainJobsOptions = {}): Promise<number> {
  const silent = { error: () => {} };
  const jobDeps = deps ?? createTestDeps({ db });
  let ran = 0;
  for (;;) {
    const claimed = await claimJob(db, new Date(), { respectRunAfter });
    if (!claimed) return ran;
    await runClaimedJob(db, claimed, {
      clock: systemClock,
      logger: silent,
      deps: () => jobDeps,
    });
    ran += 1;
  }
}
