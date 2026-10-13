import type { AppDeps } from "../../core/server/deps";
import { claimJob, runClaimedJob } from "../../core/server/jobs/store";
import { createTestDeps } from "./deps";

export type DrainJobsOptions = {
  /**
   * The dependencies the jobs run with: pass the ones the test's chat uses (its blob store, its
   * fake adapters). A fresh test set when left out.
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
  deps = createTestDeps(),
  respectRunAfter = false,
}: DrainJobsOptions = {}): Promise<number> {
  const silent = { error: () => {} };
  let ran = 0;
  for (;;) {
    const claimed = await claimJob(deps.db, new Date(), { respectRunAfter });
    if (!claimed) return ran;
    await runClaimedJob(deps.db, claimed, { now: () => new Date(), logger: silent, deps });
    ran += 1;
  }
}
