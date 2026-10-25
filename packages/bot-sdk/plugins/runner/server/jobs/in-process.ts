import type { Database } from "../../../../core/server/storage";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { jobNamesInLane } from "./define";
import { cancelJob, claimJob, enqueueJob, readJob, runClaimedJob, type ClaimedJob } from "./store";
import type { JobRunner } from "./runner";

type Logger = Pick<Console, "error">;

/**
 * Time as the runner sees it: `now` for backoff, claims and leases, and the timers for polling and
 * heartbeats. Tests inject a fake so that all of it is deterministic.
 */
export type JobClock = {
  now: () => Date;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export const systemClock: JobClock = {
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type InProcessRunnerOptions = {
  db: Database;
  logger?: Logger;
  /** Jobs outside the `helper` lane run at once in this process (ADR 0011). */
  concurrency?: number;
  /** `helper` lane jobs run at once in this process, beside the others (#602). */
  helperConcurrency?: number;
  /** How often an idle runner polls `chat.job`. Enqueue wakes it sooner. */
  pollMs?: number;
  /**
   * How long `stop()` lets running jobs finish or yield before it aborts them, and then how long
   * it waits for the aborted handlers to end.
   */
  drainMs?: number;
  clock?: JobClock;
  /** The core context, read when a job runs. The core passes its instance's. */
  deps: () => BotSdkContext;
};

/** Resolves when `promise` settles or after `ms`, whichever comes first, and clears its timer. */
async function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The in-process runner: a `JobRunner` that reads `chat.job`, and can be asked to claim now. */
export type InProcessRunner = JobRunner & {
  /** Claims due jobs now instead of at the next poll, as `enqueue` does. Does nothing before `start()`. */
  wake: () => void;
  /**
   * Runs one attempt of a job claimed elsewhere, outside the lanes' budgets, with this runner's
   * signals: `stop()` drains and aborts it, and waits for its handler. `drain` stands in for the
   * runner's deploy signal. Tests claim and run attempts by hand through it.
   */
  runClaimed: (claimed: ClaimedJob, options?: { drain?: AbortSignal }) => Promise<void>;
};

/** The runners `inProcessRunner` made. */
const inProcessRunners = new WeakSet<JobRunner>();

/** Whether `jobs` is the in-process runner, so a job queued in `chat.job` is one it runs. */
export function isInProcessRunner(jobs: JobRunner): jobs is InProcessRunner {
  return inProcessRunners.has(jobs);
}

/**
 * The default runner (ADR 0011): polls `chat.job` every `pollMs`, claims due jobs with
 * `FOR UPDATE SKIP LOCKED` and runs up to `concurrency` jobs at once, plus up to
 * `helperConcurrency` `helper` lane jobs in their own budget, so neither lane takes the other's slots. Nothing polls until `start()`.
 * `stop()` takes no new jobs and asks each running workflow to yield: at its next Checkpoint its row
 * is handed back `queued`, uncounted, for another process to resume. It waits up to `drainMs` for
 * the running jobs to finish or yield, then aborts the rest and leaves their leases to expire.
 * Handlers go on until they see their abort, lost attempts' included, so it then waits up to
 * `drainMs` more for every handler to end: it resolves within twice `drainMs`.
 */
export function inProcessRunner({
  db,
  logger = console,
  concurrency = 2,
  helperConcurrency = 4,
  pollMs = 2_000,
  drainMs = 250_000,
  clock = systemClock,
  deps,
}: InProcessRunnerOptions): InProcessRunner {
  let running = false;
  let timer: unknown;
  // Made now, so that attempts run through `runClaimed` before `start()` get them too.
  let drain = new AbortController();
  let shutdown = new AbortController();
  // Claims run one after another on this chain, so no lane's budget is ever exceeded.
  let claims: Promise<void> = Promise.resolve();
  const helpersInFlight = new Set<Promise<void>>();
  const othersInFlight = new Set<Promise<void>>();
  // Attempts run through `runClaimed`, outside the lanes, until their outcome is decided.
  const runByHand = new Set<Promise<void>>();
  // Every running handler, an attempt's that has ended included, until the handler ends too.
  const handlers = new Set<Promise<void>>();

  const run = (claimed: ClaimedJob, signals: { drain: AbortSignal; shutdown: AbortSignal }) =>
    runClaimedJob(db, claimed, { clock, logger, deps, ...signals, handlers });

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
    while (running && lane.size < budget) {
      let claimed;
      try {
        claimed = await claimJob(db, clock.now(), { names });
      } catch (error) {
        logger.error("Claiming a background job failed", error);
        return;
      }
      if (!claimed) return;
      const work: Promise<void> = run(claimed, {
        drain: drain.signal,
        shutdown: shutdown.signal,
      })
        .catch((error: unknown) => logger.error(`Background job "${claimed.name}" failed`, error))
        .finally(() => {
          lane.delete(work);
          requestClaim();
        });
      lane.add(work);
    }
  };

  const requestClaim = () => {
    if (running) claims = claims.then(claimUpToConcurrency);
  };

  const jobs: InProcessRunner = {
    async enqueue(name, payload, options = {}) {
      const id = await enqueueJob(db, name, payload, { ...options, now: clock.now() });
      requestClaim();
      return id;
    },

    async cancel(idempotencyKey) {
      await cancelJob(db, idempotencyKey, clock.now());
    },

    async status(jobId) {
      return readJob(db, jobId);
    },

    async schedule() {
      throw new Error("Recurring jobs are not supported yet");
    },

    wake: requestClaim,

    runClaimed: (claimed, options = {}) => {
      const work = run(claimed, {
        drain: options.drain ?? drain.signal,
        shutdown: shutdown.signal,
      }).finally(() => runByHand.delete(work));
      runByHand.add(work);
      return work;
    },

    async start() {
      if (running) return;
      running = true;
      if (shutdown.signal.aborted) {
        drain = new AbortController();
        shutdown = new AbortController();
      }
      timer = clock.setInterval(requestClaim, pollMs);
      requestClaim();
      await claims;
    },

    async stop() {
      running = false;
      drain.abort();
      clock.clearInterval(timer);
      timer = undefined;
      await claims;
      await waitUpTo(Promise.all([...helpersInFlight, ...othersInFlight, ...runByHand]), drainMs);
      shutdown.abort();
      await Promise.allSettled([...helpersInFlight, ...othersInFlight, ...runByHand]);
      await waitUpTo(Promise.all(handlers), drainMs);
      if (handlers.size > 0) {
        logger.error(`${handlers.size} background job handler(s) still running after stop`);
      }
    },
  };
  inProcessRunners.add(jobs);
  return jobs;
}
