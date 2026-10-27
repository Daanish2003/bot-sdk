import type { BotSdkContext } from "../plugin";
import type { JobRunner } from "./jobs/runner";
import { pruneFinishedJobs, reapStaleJobs } from "./jobs/store";

/** How often the reaper re-queues jobs whose lease has expired (ADR 0011). */
const REAP_INTERVAL_MS = 30_000;

/** How often the reaper also deletes finished background jobs past their retention (ADR 0011). */
const JOB_PRUNE_MS = 60 * 60_000;

export type RunnerLifecycle = {
  /** Reaps now, then every 30 s, then starts the jobs runner. */
  start: () => Promise<void>;
  /** Clears the reaper, then stops the jobs runner, which drains for `drainMs`, then aborts. */
  stop: () => Promise<void>;
};

/** The runner's background work: the job reaper, the prune and the jobs runner. Nothing runs before `start()`. */
export function createRunnerLifecycle(deps: BotSdkContext, jobs: JobRunner): RunnerLifecycle {
  const logger = deps.logger;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPrune = Number.NEGATIVE_INFINITY;
  const reap = async () => {
    const now = new Date();
    const requeued = await reapStaleJobs(deps.db, now, logger, deps.parts.jobs).catch(
      (error: unknown) => {
        logger.error("Reaping background jobs failed", error);
        return [];
      },
    );
    for (const jobId of requeued) jobs.requeued(jobId, now);
    if (Date.now() - lastPrune < JOB_PRUNE_MS) return;
    lastPrune = Date.now();
    await pruneFinishedJobs(deps.db, new Date()).catch((error: unknown) =>
      logger.error("Pruning finished background jobs failed", error),
    );
  };

  return {
    async start() {
      clearInterval(timer);
      timer = setInterval(() => void reap(), REAP_INTERVAL_MS);
      await reap();
      await jobs.start();
    },

    async stop() {
      clearInterval(timer);
      timer = undefined;
      await jobs.stop();
    },
  };
}
