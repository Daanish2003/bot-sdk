import { reapStaleRuns, shutdownAbort } from "./chat/run";
import { sweepExpiredTemporaryConversations } from "./chat/temporary";
import type { AppDeps } from "./deps";
import { pruneFinishedJobs, reapStaleJobs } from "./jobs/store";

/** How often `stop()` checks whether the local Runs have ended. */
const DRAIN_POLL_MS = 50;

/** How often the reaper also sweeps expired Temporary Conversations (spec #262). */
const TEMPORARY_SWEEP_MS = 60 * 60_000;

/** How often the reaper also deletes finished background jobs past their retention (ADR 0011). */
const JOB_PRUNE_MS = 60 * 60_000;

export type Lifecycle = {
  /** Reaps now, then every `reapIntervalMs` (ADR 0006). Resolves after the first reap. */
  start: () => Promise<void>;
  /**
   * Refuses new Runs, lets local Runs finish for up to `drainMs`, then ends the rest as
   * `error` "interrupted" (each Run saves itself and closes its log) and clears the reaper.
   */
  stop: () => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The SDK's background work: the reaper, and the drain that `stop()` runs. Nothing runs before `start()`. */
export function createLifecycle(
  deps: AppDeps,
  logger: Pick<Console, "error"> = console,
): Lifecycle {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastSweep = Number.NEGATIVE_INFINITY;
  let lastPrune = Number.NEGATIVE_INFINITY;
  const reap = async () => {
    await reapStaleRuns(deps).catch((error: unknown) =>
      logger.error("Reaping interrupted runs failed", error),
    );
    await reapStaleJobs(deps.db, new Date(), logger).catch((error: unknown) =>
      logger.error("Reaping background jobs failed", error),
    );
    if (Date.now() - lastPrune >= JOB_PRUNE_MS) {
      lastPrune = Date.now();
      await pruneFinishedJobs(deps.db, new Date()).catch((error: unknown) =>
        logger.error("Pruning finished background jobs failed", error),
      );
    }
    if (Date.now() - lastSweep < TEMPORARY_SWEEP_MS) return;
    lastSweep = Date.now();
    await sweepExpiredTemporaryConversations(deps).catch((error: unknown) =>
      logger.error("Sweeping expired Temporary Conversations failed", error),
    );
  };

  return {
    async start() {
      clearInterval(timer);
      timer = setInterval(() => void reap(), deps.limits.reapIntervalMs);
      await reap();
      await deps.jobs.start();
    },

    async stop() {
      deps.lifecycle.stopping = true;
      clearInterval(timer);
      timer = undefined;

      const deadline = Date.now() + deps.limits.drainMs;
      const { runs } = deps.lifecycle;
      while (runs.size > 0 && Date.now() < deadline) await sleep(DRAIN_POLL_MS);
      for (const run of runs.values()) run.abort(shutdownAbort);
      // An aborted Run leaves the registry only once it has saved itself and closed its log.
      while (runs.size > 0) await sleep(DRAIN_POLL_MS);
      await deps.jobs.stop();
    },
  };
}
