import type { Database } from "../../../../core/server/storage";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { jobNamesInLane } from "./define";
import type { Executor } from "./executor";
import {
  claimNext,
  type CoreRun,
  createJobRunner,
  type JobClock,
  type JobRunner,
  systemClock,
  wakeable,
} from "./runner";
import type { JobNames } from "./store";

type Logger = Pick<Console, "error">;

export type InProcessExecutorOptions = {
  logger?: Logger;
  /** Jobs outside the `helper` lane run at once in this process (ADR 0011). */
  concurrency?: number;
  /** `helper` lane jobs run at once in this process, beside the others (#602). */
  helperConcurrency?: number;
  /** How often an idle Executor polls `chat.job`. A `notify` wakes it sooner. */
  pollMs?: number;
  clock?: JobClock;
};

/**
 * The default Executor (ADR 0011, ADR 0029): polls `chat.job` every `pollMs` for due jobs, and at
 * once on a `notify`, and runs up to `concurrency` jobs at once, plus up to `helperConcurrency`
 * `helper` lane jobs in their own budget, so neither lane takes the other's slots. Each claim is
 * one `FOR UPDATE SKIP LOCKED` statement, through the core's `run`. A re-queued job whose lease
 * expired is due again, so the poll picks it up too. Nothing polls until `start()`, and `stop()`
 * stops polling; the core drains the running jobs.
 */
export function inProcessExecutor({
  logger = console,
  concurrency = 2,
  helperConcurrency = 4,
  pollMs = 2_000,
  clock = systemClock,
}: InProcessExecutorOptions): Executor {
  let claim: NonNullable<CoreRun[typeof claimNext]> | undefined;
  let timer: unknown;
  // Claims run one after another on this chain, so no lane's budget is ever exceeded.
  let claims: Promise<void> = Promise.resolve();
  const helpersInFlight = new Set<Promise<void>>();
  const othersInFlight = new Set<Promise<void>>();

  const claimUpToConcurrency = async () => {
    const helperNames = jobNamesInLane("helper");
    if (helperNames.length > 0) {
      await claimInto(helpersInFlight, helperConcurrency, { only: helperNames });
    }
    await claimInto(othersInFlight, concurrency, { except: helperNames });
  };

  const claimInto = async (lane: Set<Promise<void>>, budget: number, names: JobNames) => {
    while (claim && lane.size < budget) {
      let claimed;
      try {
        claimed = await claim(names);
      } catch (error) {
        logger.error("Claiming a background job failed", error);
        return;
      }
      if (!claimed) return;
      const { name, attempt } = claimed;
      const work: Promise<void> = attempt
        .catch((error: unknown) => logger.error(`Background job "${name}" failed`, error))
        .finally(() => {
          lane.delete(work);
          requestClaim();
        });
      lane.add(work);
    }
  };

  const requestClaim = () => {
    if (claim) claims = claims.then(claimUpToConcurrency);
  };

  const executor: Executor = {
    async start(run: CoreRun) {
      if (claim) return;
      // Only the core's runner starts it, and its `run` claims by name in one statement.
      claim = run[claimNext];
      if (!claim) throw new Error("The in-process Executor runs only under the core's runner");
      timer = clock.setInterval(requestClaim, pollMs);
      requestClaim();
      await claims;
    },

    async notify(_jobId, runAfter) {
      // A job due later is the poll's: a retry's backoff, a Routine's next slot.
      if (runAfter && runAfter > clock.now()) return;
      requestClaim();
      await claims;
    },

    async stop() {
      claim = undefined;
      clock.clearInterval(timer);
      timer = undefined;
      await claims;
    },
  };
  wakeable.set(executor, requestClaim);
  return executor;
}

export type InProcessRunnerOptions = InProcessExecutorOptions & {
  db: Database;
  /**
   * How long `stop()` lets running jobs finish or yield before it aborts them, and then how long
   * it waits for the aborted handlers to end.
   */
  drainMs?: number;
  /** The core context, read when a job runs. The core passes its instance's. */
  deps: () => BotSdkContext;
};

/** The core's runner on the in-process Executor: what the runner slot defaults to. */
export type InProcessRunner = JobRunner;

/** The core's runner on a new in-process Executor (see `inProcessExecutor` and `JobRunner`). */
export function inProcessRunner({
  db,
  logger,
  drainMs,
  clock,
  deps,
  ...executorOptions
}: InProcessRunnerOptions): InProcessRunner {
  return createJobRunner({
    db,
    logger,
    drainMs,
    clock,
    deps,
    executor: inProcessExecutor({ logger, clock, ...executorOptions }),
  });
}

/** Whether `jobs` runs on the in-process Executor. */
export function isInProcessRunner(jobs: JobRunner): boolean {
  return wakeable.has(jobs.executor);
}
