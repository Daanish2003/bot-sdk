import type { Database } from "../db/index";
import type { BotSdkContext } from "../plugin";
import { cancelJob, claimJob, enqueueJob, readJob, runClaimedJob } from "./store";
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
  /** Jobs run at once in this process (ADR 0011). */
  concurrency?: number;
  /** How often an idle runner polls `chat.job`. Enqueue wakes it sooner. */
  pollMs?: number;
  /** How long `stop()` lets running jobs finish before it aborts them. */
  drainMs?: number;
  clock?: JobClock;
  /** The core context, read when a job runs. The `assistant` plugin passes its instance's. */
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

/**
 * The default runner (ADR 0011): polls `chat.job` every `pollMs`, claims due jobs with
 * `FOR UPDATE SKIP LOCKED` and runs up to `concurrency` at once. Nothing polls until `start()`.
 * `stop()` takes no new jobs, waits up to `drainMs` for the running ones, then aborts them and
 * leaves their leases to expire.
 */
export function inProcessRunner({
  db,
  logger = console,
  concurrency = 2,
  pollMs = 2_000,
  drainMs = 250_000,
  clock = systemClock,
  deps,
}: InProcessRunnerOptions): JobRunner {
  let running = false;
  let timer: unknown;
  let shutdown: AbortController | undefined;
  // Claims run one after another on this chain, so `concurrency` is never exceeded.
  let claims: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();

  const claimUpToConcurrency = async () => {
    while (running && inFlight.size < concurrency) {
      let claimed;
      try {
        claimed = await claimJob(db, clock.now());
      } catch (error) {
        logger.error("Claiming a background job failed", error);
        return;
      }
      if (!claimed) return;
      const work: Promise<void> = runClaimedJob(db, claimed, {
        clock,
        logger,
        deps,
        shutdown: shutdown?.signal,
      })
        .catch((error: unknown) => logger.error(`Background job "${claimed.name}" failed`, error))
        .finally(() => {
          inFlight.delete(work);
          requestClaim();
        });
      inFlight.add(work);
    }
  };

  const requestClaim = () => {
    if (running) claims = claims.then(claimUpToConcurrency);
  };

  return {
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

    async start() {
      if (running) return;
      running = true;
      shutdown = new AbortController();
      timer = clock.setInterval(requestClaim, pollMs);
      requestClaim();
      await claims;
    },

    async stop() {
      running = false;
      clock.clearInterval(timer);
      timer = undefined;
      await claims;
      await waitUpTo(Promise.all(inFlight), drainMs);
      shutdown?.abort();
      await Promise.all(inFlight);
    },
  };
}
