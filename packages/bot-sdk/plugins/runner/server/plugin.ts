import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import { runRegisteredJob } from "./jobs/define";
import { inProcessRunner } from "./jobs/in-process";
import type { JobRunner } from "./jobs/runner";
import { createRunnerLifecycle, type RunnerLifecycle } from "./lifecycle";

export type RunnerOptions = {
  /**
   * Runs the background jobs (ADR 0011). Defaults to the in-process runner, which polls the
   * `chat` schema and needs nothing beyond Postgres. `start()` and `stop()` start and stop it.
   */
  jobs?: JobRunner;
};

/** The `runner` plugin's API (`sdk.plugin("runner")`): the jobs the other plugins queue. */
export type RunnerApi = Pick<JobRunner, "enqueue" | "cancel" | "status"> & {
  /**
   * Runs a job's handler in this process, with the payload validated against the job's schema.
   * Rejects an unknown name or a bad payload. A Host's worker (such as a Trigger.dev task) calls it.
   */
  runJob: (name: string, payload: unknown) => Promise<void>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    runner: RunnerApi;
  }
}

export type RunnerPlugin = BotSdkPlugin<"runner", never, never>;

// Each instance's jobs runner, keyed by its `runner` API, which `plugin("runner")` returns.
const jobRunners = new WeakMap<object, JobRunner>();

/** The instance's `JobRunner`, found through the context's `plugin("runner")`. The test seam reuses it. */
export function runnerJobs(sdk: Pick<BotSdkContext, "plugin">): JobRunner {
  const jobs = jobRunners.get(sdk.plugin("runner"));
  if (!jobs) throw new Error("The runner plugin isn't enabled");
  return jobs;
}

/**
 * The `runner` plugin (ADR 0011, ADR 0020): background jobs, their reaper and their prune, shared
 * by the plugins that require it. It starts before them and stops after them.
 */
export function runner(options: RunnerOptions = {}): RunnerPlugin {
  // One lifecycle per instance, built by `init`.
  const lifecycles = new WeakMap<BotSdkContext, RunnerLifecycle>();
  const lifecycleOf = (sdk: BotSdkContext) => {
    const lifecycle = lifecycles.get(sdk);
    if (!lifecycle) throw new Error("The runner plugin wasn't initialised");
    return lifecycle;
  };
  return {
    id: "runner",
    init: (sdk) => {
      const jobs =
        options.jobs ?? inProcessRunner({ db: sdk.db, logger: sdk.logger, deps: () => sdk });
      const api: RunnerApi = {
        enqueue: (name, payload, enqueueOptions) => jobs.enqueue(name, payload, enqueueOptions),
        cancel: (idempotencyKey) => jobs.cancel(idempotencyKey),
        status: (jobId) => jobs.status(jobId),
        runJob: (name, payload) => runRegisteredJob(name, payload, sdk),
      };
      jobRunners.set(api, jobs);
      lifecycles.set(sdk, createRunnerLifecycle(sdk, jobs));
      return { api };
    },
    // The reaper, then the jobs runner.
    start: (sdk) => lifecycleOf(sdk).start(),
    // Drains the jobs, after the plugins that require the runner have stopped.
    stop: (sdk) => lifecycleOf(sdk).stop(),
  };
}
