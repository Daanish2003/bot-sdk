import type { JobRow } from "../db/schema/job";

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
 * Runs background jobs (ADR 0011). `createBotSdk({ jobs })` takes one; the default is the
 * in-process runner, which claims jobs from `chat.job`. `start()` and `stop()` are called by
 * `chat.start()` and `chat.stop()`.
 */
export type JobRunner = {
  /** Queues a job and returns its id. With an active idempotency key, returns that job's id. */
  enqueue: (name: string, payload: unknown, options?: EnqueueOptions) => Promise<string>;
  /** Drops the queued job with this key, or aborts the running one at its next heartbeat. */
  cancel: (idempotencyKey: string) => Promise<void>;
  status: (jobId: string) => Promise<JobStatus | undefined>;
  /** Recurring jobs. Built with Synced sources (spec 2); the in-process runner throws until then. */
  schedule: (name: string, options: { everyMs: number }) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
