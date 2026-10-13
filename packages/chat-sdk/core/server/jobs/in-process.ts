import type { AppDeps } from "../deps";
import type { Database } from "../db/index";
import { claimJob, enqueueJob, runClaimedJob } from "./store";
import type { JobRunner } from "./runner";

type Logger = Pick<Console, "error">;

/**
 * Time as the runner sees it: `now` for backoff and claims, and the poll timer. Tests inject a
 * fake so that backoff and polling are deterministic.
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
  /**
   * The SDK's dependencies, handed to each job. A getter, because the dependencies hold this
   * runner: `createAppDeps` passes a closure over the object it builds.
   */
  deps: () => AppDeps;
  logger?: Logger;
  /** Jobs run at once in this process (ADR 0011). */
  concurrency?: number;
  /** How often an idle runner polls `chat.job`. Enqueue wakes it sooner. */
  pollMs?: number;
  clock?: JobClock;
};

/**
 * The default runner (ADR 0011): polls `chat.job` every `pollMs`, claims due jobs with
 * `FOR UPDATE SKIP LOCKED` and runs up to `concurrency` at once. Nothing polls until `start()`.
 * `stop()` takes no new jobs and waits for the running ones.
 */
export function inProcessRunner({
  db,
  deps,
  logger = console,
  concurrency = 2,
  pollMs = 2_000,
  clock = systemClock,
}: InProcessRunnerOptions): JobRunner {
  let running = false;
  let timer: unknown;
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
        now: clock.now,
        logger,
        deps: deps(),
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
      await enqueueJob(db, name, payload, { ...options, now: clock.now() });
      requestClaim();
    },

    async start() {
      if (running) return;
      running = true;
      timer = clock.setInterval(requestClaim, pollMs);
      requestClaim();
      await claims;
    },

    async stop() {
      running = false;
      clock.clearInterval(timer);
      timer = undefined;
      await claims;
      await Promise.all(inFlight);
    },
  };
}
