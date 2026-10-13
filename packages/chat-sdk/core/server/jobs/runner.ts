export type EnqueueOptions = {
  /** A job with this key that is still queued or running makes this enqueue a no-op. */
  idempotencyKey?: string;
  /** The earliest time the job may run. Defaults to now. */
  runAfter?: Date;
};

/**
 * Runs background jobs (ADR 0011). `createChat({ jobs })` takes one; the default is the
 * in-process runner, which claims jobs from `chat.job`. `start()` and `stop()` are called by
 * `chat.start()` and `chat.stop()`.
 */
export type JobRunner = {
  enqueue: (name: string, payload: unknown, options?: EnqueueOptions) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
