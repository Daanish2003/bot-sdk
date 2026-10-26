import type { Database } from "../../../../core/server/storage";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { jobNamesInLane } from "./define";
import type { Executor } from "./executor";
import { createJobRunner, type JobClock, type JobRunner, systemClock, wakeable } from "./runner";
import { dueJobId } from "./store";

type Logger = Pick<Console, "error">;

export type InProcessExecutorOptions = {
  db: Database;
  logger?: Logger;
  /** Jobs outside the `helper` lane run at once in this process (ADR 0011). */
  concurrency?: number;
  /** `helper` lane jobs run at once in this process, beside the others (#602). */
  helperConcurrency?: number;
  /** How often an idle Executor polls `chat.job`. A `notify` wakes it sooner. */
  pollMs?: number;
  clock?: JobClock;
};

/** The Executors `inProcessExecutor` made. */
const inProcessExecutors = new WeakSet<Executor>();

/**
 * The default Executor (ADR 0011, ADR 0029): polls `chat.job` every `pollMs` for due jobs, and at
 * once on a `notify`, and runs up to `concurrency` jobs at once, plus up to `helperConcurrency`
 * `helper` lane jobs in their own budget, so neither lane takes the other's slots. A re-queued job
 * whose lease expired is due again, so the poll picks it up too. Nothing polls until `start()`, and
 * `stop()` stops polling; the core drains the running jobs.
 */
export function inProcessExecutor({
  db,
  logger = console,
  concurrency = 2,
  helperConcurrency = 4,
  pollMs = 2_000,
  clock = systemClock,
}: InProcessExecutorOptions): Executor {
  let run: ((jobId: string) => Promise<void>) | undefined;
  let timer: unknown;
  // Claims run one after another on this chain, so no lane's budget is ever exceeded.
  let claims: Promise<void> = Promise.resolve();
  const helpersInFlight = new Set<Promise<void>>();
  const othersInFlight = new Set<Promise<void>>();
  // The jobs this Executor is running, so a claim pass never picks one twice.
  const inFlight = new Set<string>();

  const claimUpToConcurrency = async () => {
    const helperNames = jobNamesInLane("helper");
    if (helperNames.length > 0) {
      await claimInto(helpersInFlight, helperConcurrency, { only: helperNames });
    }
    await claimInto(othersInFlight, concurrency, { except: helperNames });
  };

  const claimInto = async (
    lane: Set<Promise<void>>,
    budget: number,
    names: { only: string[] } | { except: string[] },
  ) => {
    while (run && lane.size < budget) {
      let jobId;
      try {
        jobId = await dueJobId(db, clock.now(), { names, skip: [...inFlight] });
      } catch (error) {
        logger.error("Claiming a background job failed", error);
        return;
      }
      if (!jobId || !run) return;
      const id = jobId;
      inFlight.add(id);
      const work: Promise<void> = run(id)
        .catch((error: unknown) => logger.error(`Background job ${id} failed`, error))
        .finally(() => {
          lane.delete(work);
          inFlight.delete(id);
          requestClaim();
        });
      lane.add(work);
    }
  };

  const requestClaim = () => {
    if (run) claims = claims.then(claimUpToConcurrency);
  };

  const executor: Executor = {
    async start(given) {
      if (run) return;
      run = given;
      timer = clock.setInterval(requestClaim, pollMs);
      requestClaim();
      await claims;
    },

    async notify() {
      requestClaim();
      await claims;
    },

    async stop() {
      run = undefined;
      clock.clearInterval(timer);
      timer = undefined;
      await claims;
    },
  };
  inProcessExecutors.add(executor);
  wakeable.set(executor, requestClaim);
  return executor;
}

export type InProcessRunnerOptions = Omit<InProcessExecutorOptions, "db"> & {
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
    executor: inProcessExecutor({ db, logger, clock, ...executorOptions }),
  });
}

/** Whether `jobs` runs on the in-process Executor. */
export function isInProcessRunner(jobs: JobRunner): boolean {
  return inProcessExecutors.has(jobs.executor);
}
