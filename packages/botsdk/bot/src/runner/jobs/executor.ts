/**
 * What wakes up and runs a due job (ADR 0029, #862): the runner's one seam. The core keeps
 * everything that makes Checkpoints exactly-once (history replay, `botsdk.job`, leases and the
 * attempt fence, retries, transactional enqueue and cancel, pruning, abort), whatever the Executor.
 *
 * - `start(run)` hands the Executor the core's entry point. `run(jobId)` claims the job's lease and
 *   replays its history, so calling it twice, at once or after a crash, is harmless. It does nothing
 *   for a job that isn't queued and due, and resolves once the attempt's outcome is decided.
 * - `notify(jobId, runAfter)` is called after the transaction that queued the job (or re-queued it,
 *   for a retry) commits, never before. `runAfter` is when it is due; without it, it is due now.
 * - `stop()` stops running new jobs. The core then drains the attempts running in this process.
 */
export type Executor = {
  start(run: (jobId: string) => Promise<void>): Promise<void>;
  notify(jobId: string, runAfter?: Date): Promise<void>;
  stop(): Promise<void>;
};
