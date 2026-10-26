import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import type { Executor } from "./jobs/executor";
import { inProcessRunner } from "./jobs/in-process";
import { createJobRunner, type EnqueueOptions, type JobRunner } from "./jobs/runner";
import { createRunnerLifecycle, type RunnerLifecycle } from "./lifecycle";

/** The runner, a core service (`sdk.runner`, spec #871): the background jobs the SDK queues. */
export type RunnerApi = Pick<JobRunner, "enqueue" | "cancel" | "status"> & {
  /**
   * Queues a job in the caller's transaction, so it exists only if that transaction commits, and
   * returns its id. The Executor is notified once the transaction has committed.
   */
  enqueueIn: (
    tx: Transaction,
    name: string,
    payload: unknown,
    options?: EnqueueOptions,
  ) => Promise<string>;
  /**
   * Cancels the active job with this key in the caller's transaction, and returns what it was
   * (`queued` never runs; `running` aborts at its next heartbeat or write), or undefined when
   * none is active.
   */
  cancelIn: (tx: Transaction, idempotencyKey: string) => Promise<"queued" | "running" | undefined>;
  /** `JobRunner.replaceIfNotStarted`, on the instance's clock. */
  replaceIfNotStarted: (
    tx: Transaction,
    idempotencyKey: string,
    name: string,
    payload: unknown,
    options?: Pick<EnqueueOptions, "runAfter">,
  ) => Promise<string | undefined>;
  /** Has the in-process runner claim due jobs now instead of at its next poll. */
  wake: () => void;
};

// Each instance's jobs runner, keyed by its `runner` service.
const jobRunners = new WeakMap<RunnerApi, JobRunner>();

/** The instance's `JobRunner`, found through its `runner` service. The test seam reuses it. */
export function runnerJobs(sdk: Pick<BotSdkContext, "runner">): JobRunner {
  const jobs = jobRunners.get(sdk.runner);
  if (!jobs) throw new Error("The runner wasn't built by createBotSdk");
  return jobs;
}

/**
 * The runner (ADR 0011, ADR 0029), a core service: background jobs, their reaper and their prune,
 * woken up by `executor` (the runner slot) or else the in-process Executor, which polls the `chat`
 * schema and needs nothing beyond Postgres. `given` is the test seam's own runner. Its lifecycle
 * starts after the plugins' `start` and stops after their `stop`.
 */
export function createRunner(
  sdk: BotSdkContext,
  executor?: Executor,
  given?: JobRunner,
): { api: RunnerApi; lifecycle: RunnerLifecycle } {
  // Read once the factory has listed them, after the features are enabled.
  const table = () => sdk.parts.jobs;
  const jobs =
    given ??
    (executor
      ? createJobRunner({ db: sdk.db, logger: sdk.logger, jobs: table, executor })
      : inProcessRunner({ db: sdk.db, logger: sdk.logger, jobs: table }));
  const api: RunnerApi = {
    enqueue: (name, payload, enqueueOptions) => jobs.enqueue(name, payload, enqueueOptions),
    cancel: (idempotencyKey) => jobs.cancel(idempotencyKey),
    status: (jobId) => jobs.status(jobId),
    enqueueIn: (tx, name, payload, enqueueOptions) =>
      jobs.enqueueIn(tx, name, payload, { ...enqueueOptions, now: sdk.clock() }),
    cancelIn: (tx, idempotencyKey) => jobs.cancelIn(tx, idempotencyKey, sdk.clock()),
    replaceIfNotStarted: (tx, idempotencyKey, name, payload, options) =>
      jobs.replaceIfNotStarted(tx, idempotencyKey, name, payload, {
        ...options,
        now: sdk.clock(),
      }),
    wake: () => jobs.wake(),
  };
  jobRunners.set(api, jobs);
  return { api, lifecycle: createRunnerLifecycle(sdk, jobs) };
}
