import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { runRegisteredJob } from "./jobs/define";
import type { Executor } from "./jobs/executor";
import { inProcessRunner } from "./jobs/in-process";
import { createJobRunner, type EnqueueOptions, type JobRunner } from "./jobs/runner";
import { createRunnerLifecycle, type RunnerLifecycle } from "./lifecycle";

/** The runner, a core service (`sdk.runner`, spec #871): the background jobs the SDK queues. */
export type RunnerApi = Pick<JobRunner, "enqueue" | "cancel" | "status"> & {
  /**
   * Runs a job's handler in this process, with the payload validated against the job's schema.
   * Rejects an unknown name or a bad payload. A Host's worker (such as a Trigger.dev task) calls it.
   */
  runJob: (name: string, payload: unknown) => Promise<void>;
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
  const deps = () => sdk;
  const jobs =
    given ??
    (executor
      ? createJobRunner({ db: sdk.db, logger: sdk.logger, deps, executor })
      : inProcessRunner({ db: sdk.db, logger: sdk.logger, deps }));
  const api: RunnerApi = {
    enqueue: (name, payload, enqueueOptions) => jobs.enqueue(name, payload, enqueueOptions),
    cancel: (idempotencyKey) => jobs.cancel(idempotencyKey),
    status: (jobId) => jobs.status(jobId),
    runJob: (name, payload) => runRegisteredJob(name, payload, sdk),
    enqueueIn: (tx, name, payload, enqueueOptions) =>
      jobs.enqueueIn(tx, name, payload, { ...enqueueOptions, now: sdk.clock() }),
    cancelIn: (tx, idempotencyKey) => jobs.cancelIn(tx, idempotencyKey, sdk.clock()),
    wake: () => jobs.wake(),
  };
  jobRunners.set(api, jobs);
  return { api, lifecycle: createRunnerLifecycle(sdk, jobs) };
}
