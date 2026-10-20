import type { Database } from "../../core/server/db/index";
import { inProcessRunner, type JobClock } from "../../plugins/runner/server/jobs/in-process";
import { claimJob } from "../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps } from "./deps";
import { getTestDb } from "./test-database";

export type DrainJobsOptions = {
  db?: Database;
  /**
   * The dependencies the jobs run with. A test that drains a job which calls models passes the
   * deps its Run used, so the fakes are the same. Defaults to fresh test deps.
   */
  deps?: TestDeps;
  /**
   * `false` (the default) runs every queued job now, even one in its retry backoff, so a test
   * need not move a clock. `true` runs only the jobs due at the real time, then returns.
   */
  respectRunAfter?: boolean;
  /** With `respectRunAfter`, the time the jobs must be due by. Defaults to the real time. */
  now?: Date;
};

/**
 * Runs queued jobs inline, one after another, until none are left, and returns how many ran. A
 * job that enqueues another has that one run too. A failing job is retried in the same drain, up
 * to its attempts, so the drain always ends. Failures are recorded on the row, not thrown. It
 * returns once every handler has ended, a lost attempt's included.
 */
export async function drainJobs({
  db = getTestDb(),
  respectRunAfter = false,
  now,
  deps,
}: DrainJobsOptions = {}): Promise<number> {
  const silent = { error: () => {} };
  const jobDeps = deps ?? createTestSdk({ db });
  // Never started: it runs the attempts claimed here, and its `stop()` waits for their handlers.
  const runner = inProcessRunner({ db, logger: silent, deps: () => jobDeps });
  let ran = 0;
  for (;;) {
    const claimed = await claimJob(db, now ?? new Date(), { respectRunAfter });
    if (!claimed) break;
    await runner.runClaimed(claimed);
    ran += 1;
  }
  await runner.stop();
  return ran;
}

/** A clock the test moves by hand; `tick()` fires every timer (poll and heartbeat). */
export function fakeJobClock(start: Date) {
  let current = start.getTime();
  const timers = new Set<() => void>();
  const intervals: number[] = [];
  const clock: JobClock = {
    now: () => new Date(current),
    setInterval: (callback, ms) => {
      intervals.push(ms);
      timers.add(callback);
      return callback;
    },
    clearInterval: (handle) => {
      timers.delete(handle as () => void);
    },
  };
  return {
    clock,
    intervals,
    advance: (ms: number) => {
      current += ms;
    },
    tick: () => {
      for (const timer of timers) timer();
    },
  };
}
