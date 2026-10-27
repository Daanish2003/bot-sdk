import type { Executor } from "@botsdk/bot/runner/internal";

/**
 * An Executor that runs nothing by itself (spec #872): it records each `notify`, and the test calls
 * `run` when it decides to, twice at once or after a simulated crash included.
 */
export function manualExecutor() {
  let run: ((jobId: string) => Promise<void>) | undefined;
  const notified: { jobId: string; runAfter?: Date }[] = [];
  const executor: Executor = {
    start: async (given) => {
      run = given;
    },
    notify: async (jobId, runAfter) => {
      notified.push({ jobId, ...(runAfter && { runAfter }) });
    },
    stop: async () => {
      run = undefined;
    },
  };
  return {
    executor,
    notified,
    /** Runs the job as the core's `run`, which `start` received. */
    run: (jobId: string) => {
      if (!run) throw new Error("The manual Executor hasn't been started");
      return run(jobId);
    },
  };
}

/** `executor`, with each `notify` it gets recorded in `notified` before it is passed on. */
export function recordingNotify<E extends Executor>(executor: E) {
  const notified: { jobId: string; runAfter?: Date }[] = [];
  const notify: Executor["notify"] = (jobId, runAfter) => {
    notified.push({ jobId, ...(runAfter && { runAfter }) });
    return executor.notify(jobId, runAfter);
  };
  return { executor: { ...executor, notify }, notified };
}
