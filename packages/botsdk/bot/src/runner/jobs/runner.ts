import type { Transaction } from "../../plugin";
import type { Database, JobRow } from "../../storage";
import { afterCommit, trackCommits } from "./commit";
import { budgetsOf, type JobBudget, type JobTable } from "./define";
import type { Executor } from "./executor";
import {
  type ActiveJob,
  type JobNames,
  activeJobsByKeyPrefix,
  cancelJob,
  cancelJobIn,
  checkpointCounts,
  claimJob,
  dueJobIds,
  enqueueJob,
  jobNames,
  newestCheckpoints,
  pruneFinishedJobs,
  readJob,
  reapStaleJobs,
  replaceJobIfNotStartedIn,
  runClaimedJob,
  type ClaimedJob,
} from "./store";

type Logger = Pick<Console, "error">;

export type { ActiveJob };

export type EnqueueOptions = {
  /** A job with this key that is still queued or running makes this enqueue a no-op. */
  idempotencyKey?: string;
  /** The earliest time the job may run. Defaults to now. */
  runAfter?: Date;
};

/** A job as an operator or an adapter sees it. Users see their domain row instead (ADR 0011). */
export type JobStatus = {
  id: string;
  name: string;
  status: JobRow["status"];
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAfter: Date;
  createdAt: Date;
  updatedAt: Date;
};

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

/**
 * The core's runner (ADR 0029, #862): background jobs in `botsdk.job`, run through an Executor that
 * only wakes them up. `start()` and `stop()` are called through `chat.start()` and `chat.stop()`.
 */
export type JobRunner = {
  /** The Executor that wakes this runner's jobs up. */
  executor: Executor;
  /** Queues a job and returns its id. With an active idempotency key, returns that job's id. */
  enqueue: (name: string, payload: unknown, options?: EnqueueOptions) => Promise<string>;
  /**
   * Queues a job in the caller's transaction, so it exists only if that transaction commits, and
   * returns its id. The Executor is notified once the transaction has committed, when it is a
   * transaction of the SDK's database instance; one of another Drizzle instance on the same
   * Postgres skips the notify, and the in-process poll picks the job up (an Executor that doesn't
   * poll needs the SDK's transaction). `now` defaults to the runner's clock.
   */
  enqueueIn: (
    tx: Transaction,
    name: string,
    payload: unknown,
    options?: EnqueueOptions & { now?: Date },
  ) => Promise<string>;
  /**
   * Drops the queued job with this key, or aborts the running one at its next heartbeat or, sooner,
   * at its next Checkpoint, whose save is fenced. A plain activity's side effect has run by then,
   * and only its Checkpoint is dropped; a `(tx) =>` activity's write is rolled back.
   */
  cancel: (idempotencyKey: string) => Promise<void>;
  /**
   * Cancels the active job with this key in the caller's transaction, and returns what it was
   * (`queued` never runs; `running` aborts at its next heartbeat or write), or undefined when
   * none is active. `now` defaults to the runner's clock.
   */
  cancelIn: (
    tx: Transaction,
    idempotencyKey: string,
    now?: Date,
  ) => Promise<"queued" | "running" | undefined>;
  /**
   * In the caller's transaction, replaces the queued job `name` with this key, if it hasn't started,
   * by one with `payload` (`replaceJobIfNotStartedIn`), and returns its id. The Executor is
   * notified once the transaction has committed, as with `enqueueIn` (only for the SDK's
   * transaction; otherwise the poll picks it up). Returns undefined, changing nothing, when no such
   * job is active or it has started. `now` defaults to the runner's clock.
   */
  replaceIfNotStarted: (
    tx: Transaction,
    idempotencyKey: string,
    name: string,
    payload: unknown,
    options?: { runAfter?: Date; now?: Date },
  ) => Promise<string | undefined>;
  status: (jobId: string) => Promise<JobStatus | undefined>;
  /**
   * The active (queued or running) jobs `name` whose key starts with one of `keyPrefixes`, read in
   * `db` or a transaction. With `status`, only those in that status.
   */
  activeJobs: (
    db: Database | Transaction,
    query: { name: string; keyPrefixes: string[]; status?: ActiveJob["status"] },
  ) => Promise<ActiveJob[]>;
  /**
   * How many Checkpoints named `name` each of the jobs has recorded, read in `db` or a transaction.
   * A job with none is left out.
   */
  checkpointCounts: (
    db: Database | Transaction,
    jobIds: string[],
    name: string,
  ) => Promise<Map<string, number>>;
  /**
   * The result of the newest Checkpoint named `name` of each of the jobs, read in `db` or a
   * transaction. A job with none is left out.
   */
  newestCheckpoints: (
    db: Database | Transaction,
    jobIds: string[],
    name: string,
  ) => Promise<Map<string, unknown>>;
  /** Recurring jobs. Built with Synced sources (spec 2); the runner throws until then. */
  schedule: (name: string, options: { everyMs: number }) => Promise<void>;
  /**
   * The core's entry point, which the Executor calls: claims the job's lease if it is queued and
   * due, replays its history and runs it, and resolves once the attempt's outcome is decided.
   * Otherwise, or once `stop()` has begun, it does nothing.
   */
  runJob: (jobId: string) => Promise<void>;
  /**
   * Runs one attempt of a job claimed elsewhere, with this runner's signals: `stop()` drains and
   * aborts it, and waits for its handler. `drain` stands in for the runner's deploy signal. Tests
   * claim and run attempts by hand through it.
   */
  runClaimed: (claimed: ClaimedJob, options?: { drain?: AbortSignal }) => Promise<void>;
  /** Has the in-process Executor claim due jobs now instead of at its next poll. */
  wake: () => void;
  /** Re-queues the jobs whose lease has expired at `now` and returns their ids. */
  reap: (now: Date) => Promise<string[]>;
  /**
   * Deletes finished jobs past their retention, at most once an hour for this runner; a failure is
   * logged. The reaper and an Executor's sweep share it, and so its throttle.
   */
  pruneIfDue: (now: Date) => Promise<void>;
  /** Re-queued jobs (a retry, a yield, an expired lease) are passed to the Executor through it. */
  requeued: (jobId: string, runAfter: Date) => void;
  start: () => Promise<void>;
  /**
   * Stops the Executor, so no new job starts, and asks each running workflow to yield: at its next
   * Checkpoint its row is handed back `queued`, uncounted, for another process to resume. It waits
   * up to `drainMs` for the running jobs to finish or yield, then aborts the rest and leaves their
   * leases to expire. Handlers go on until they see their abort, lost attempts' included, so it
   * then waits up to `drainMs` more for every handler to end: it resolves within twice `drainMs`.
   */
  stop: () => Promise<void>;
};

export type JobRunnerOptions = {
  db: Database;
  executor: Executor;
  logger?: Logger;
  /**
   * How long `stop()` lets running jobs finish or yield before it aborts them, and then how long
   * it waits for the aborted handlers to end.
   */
  drainMs?: number;
  clock?: JobClock;
  /** The instance's jobs (spec #872), read when one is queued or run. */
  jobs: () => JobTable;
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

/** The in-process Executors, each with the wake that has it claim due jobs now. */
export const wakeable = new WeakMap<Executor, () => void>();

/**
 * The in-process Executor's own way in, on the `run` the core starts it with: claims the next due
 * job among `names` in one statement, as `runJob` would, and returns its attempt (which resolves
 * once the outcome is decided), or undefined when none is due or the runner is stopping.
 */
export const claimNext = Symbol("claimNext");

/** The in-process Executor's other way in: the budgets of the jobs with a `concurrency`. */
export const jobBudgets = Symbol("jobBudgets");

/**
 * The way in of an Executor that limits concurrency itself (Inngest's): the budget key (see
 * `JobBudget`) of each given job that is in a budget, by job id.
 */
export const jobBudgetKeys = Symbol("jobBudgetKeys");

/**
 * The way in of an Executor that doesn't poll (Inngest's sweep): re-queues the jobs whose lease has
 * expired, has `wake` wake the jobs that are due (those it re-queued first, then the other queued
 * due jobs, oldest first, up to a limit), then prunes finished jobs (`JobRunner.pruneIfDue`).
 */
export const sweepJobs = Symbol("sweepJobs");

/** How often a process deletes finished background jobs past their retention (ADR 0011). */
const JOB_PRUNE_MS = 60 * 60_000;

export type CoreRun = ((jobId: string) => Promise<void>) & {
  [sweepJobs]?: (wake: (jobIds: string[]) => Promise<void>) => Promise<void>;
  [claimNext]?: (names: JobNames) => Promise<{ name: string; attempt: Promise<void> } | undefined>;
  [jobBudgets]?: () => readonly JobBudget[];
  [jobBudgetKeys]?: (jobIds: string[]) => Promise<Map<string, string>>;
};

/** The core's runner over `executor` (see `JobRunner`). Nothing runs before `start()`. */
export function createJobRunner({
  db,
  executor,
  logger = console,
  drainMs = 250_000,
  clock = systemClock,
  jobs,
}: JobRunnerOptions): JobRunner {
  trackCommits(db);
  let stopping = false;
  // Made now, so that attempts run through `runClaimed` before `start()` get them too.
  let drain = new AbortController();
  let shutdown = new AbortController();
  // Attempts running in this process until their outcome is decided.
  const attempts = new Set<Promise<void>>();
  // Every running handler, an attempt's that has ended included, until the handler ends too.
  const handlers = new Set<Promise<void>>();

  const notify = (jobId: string, runAfter?: Date) => {
    // Never throws: a hook after a commit must not fail the transaction that has committed.
    Promise.resolve()
      .then(() => executor.notify(jobId, runAfter))
      .catch((error: unknown) =>
        logger.error(`Notifying the Executor of job ${jobId} failed`, error),
      );
  };
  const requeued = (jobId: string, runAfter: Date) => notify(jobId, runAfter);

  const runAttempt = (claimed: ClaimedJob, drainSignal: AbortSignal) => {
    const work = runClaimedJob(db, claimed, {
      clock,
      logger,
      jobs,
      drain: drainSignal,
      shutdown: shutdown.signal,
      handlers,
      requeued,
    }).finally(() => attempts.delete(work));
    attempts.add(work);
    return work;
  };

  // A claim in flight is an attempt too, so `stop()` drains it.
  const claimThenRun = (claim: () => Promise<ClaimedJob | undefined>) => {
    let claimed: Promise<ClaimedJob | undefined>;
    const work = (async () => {
      claimed = claim();
      const job = await claimed;
      if (job) await runAttempt(job, drain.signal);
    })().finally(() => attempts.delete(work));
    attempts.add(work);
    return { claimed: claimed!, work };
  };

  const runJob: CoreRun = async (jobId) => {
    if (stopping) return;
    // Waits for a row another transaction holds, so a claim in flight elsewhere never makes it skip.
    await claimThenRun(() => claimJob(db, clock.now(), { id: jobId, wait: true })).work;
  };
  runJob[claimNext] = async (names) => {
    if (stopping) return undefined;
    const { claimed, work } = claimThenRun(() => claimJob(db, clock.now(), { names }));
    const job = await claimed;
    return job && { name: job.name, attempt: work };
  };
  runJob[jobBudgets] = () => budgetsOf(jobs());
  let keysByName: Map<string, string> | undefined;
  runJob[jobBudgetKeys] = async (jobIds) => {
    // The job table is fixed, so the map is made once.
    keysByName ??= new Map(budgetsOf(jobs()).flatMap((b) => b.names.map((name) => [name, b.key])));
    const keys = keysByName;
    const keyed = new Map<string, string>();
    for (const { id, name } of await jobNames(db, jobIds)) {
      const key = keys.get(name);
      if (key !== undefined) keyed.set(id, key);
    }
    return keyed;
  };
  const reap = (now: Date) => reapStaleJobs(db, now, logger, jobs());
  let lastPrune = Number.NEGATIVE_INFINITY;
  const pruneIfDue = async (now: Date) => {
    if (Date.now() - lastPrune < JOB_PRUNE_MS) return;
    lastPrune = Date.now();
    await pruneFinishedJobs(db, now).catch((error: unknown) =>
      logger.error("Pruning finished background jobs failed", error),
    );
  };
  runJob[sweepJobs] = async (wake) => {
    const now = clock.now();
    const reaped = await reap(now);
    const listed = new Set(reaped);
    // The jobs it re-queued first, so that older due jobs never push them past the limit.
    const due = (await dueJobIds(db, now)).filter((id) => !listed.has(id));
    await wake([...reaped, ...due]);
    await pruneIfDue(now);
  };

  return {
    executor,

    async enqueue(name, payload, options = {}) {
      const id = await enqueueJob(db, jobs(), name, payload, { ...options, now: clock.now() });
      notify(id, options.runAfter);
      return id;
    },

    async enqueueIn(tx, name, payload, options = {}) {
      const id = await enqueueJob(tx, jobs(), name, payload, {
        ...options,
        now: options.now ?? clock.now(),
      });
      afterCommit(tx, () => notify(id, options.runAfter));
      return id;
    },

    async cancel(idempotencyKey) {
      await cancelJob(db, idempotencyKey, clock.now());
    },

    cancelIn: (tx, idempotencyKey, now = clock.now()) => cancelJobIn(tx, idempotencyKey, now),

    async replaceIfNotStarted(tx, idempotencyKey, name, payload, options = {}) {
      const id = await replaceJobIfNotStartedIn(tx, jobs(), idempotencyKey, name, payload, {
        runAfter: options.runAfter,
        now: options.now ?? clock.now(),
      });
      if (id) afterCommit(tx, () => notify(id, options.runAfter));
      return id;
    },

    status: (jobId) => readJob(db, jobId),

    activeJobs: activeJobsByKeyPrefix,

    checkpointCounts,

    newestCheckpoints,

    async schedule() {
      throw new Error("Recurring jobs are not supported yet");
    },

    runJob,

    runClaimed: (claimed, options = {}) => runAttempt(claimed, options.drain ?? drain.signal),

    wake: () => wakeable.get(executor)?.(),

    reap,

    pruneIfDue,

    requeued,

    async start() {
      stopping = false;
      if (shutdown.signal.aborted) {
        drain = new AbortController();
        shutdown = new AbortController();
      }
      await executor.start(runJob);
    },

    async stop() {
      stopping = true;
      drain.abort();
      await executor.stop();
      await waitUpTo(Promise.all(attempts), drainMs);
      shutdown.abort();
      await Promise.allSettled(attempts);
      await waitUpTo(Promise.all(handlers), drainMs);
      if (handlers.size > 0) {
        logger.error(`${handlers.size} background job handler(s) still running after stop`);
      }
    },
  };
}
