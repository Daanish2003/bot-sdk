import type { z } from "zod";

/**
 * A failure retrying can't fix, such as a PDF with no text layer. It fails the job at once
 * (ADR 0011).
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** A job as internal code declares it. Jobs are internal: a Host can't register its own. */
export type JobDefinition<P> = {
  name: string;
  payload: z.ZodType<P>;
  run: (payload: P) => Promise<void>;
  /** Runs once, after the final failure (the last attempt, or a `PermanentJobError`). */
  onFailed?: (payload: P, error: unknown) => Promise<void> | void;
};

/** A definition as the runner holds it, with its payload type erased. */
export type RegisteredJob = {
  name: string;
  payload: z.ZodType<unknown>;
  run: (payload: unknown) => Promise<void>;
  onFailed?: (payload: unknown, error: unknown) => Promise<void> | void;
};

const registry = new Map<string, RegisteredJob>();

/** Declares a job and registers it by name. A name can be defined once. */
export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (registry.has(definition.name)) {
    throw new Error(`A job named "${definition.name}" is already defined`);
  }
  registry.set(definition.name, definition as unknown as RegisteredJob);
  return definition;
}

export function registeredJob(name: string): RegisteredJob | undefined {
  return registry.get(name);
}

/** Milliseconds to wait before attempt 2, 3, and so on: about 10 s, 1 min, then 5 min. */
const retryBackoffMs = [10_000, 60_000, 300_000];

/** The wait before the next attempt, once `attempts` have failed. */
export function backoffAfter(attempts: number): number {
  return retryBackoffMs[Math.min(attempts, retryBackoffMs.length) - 1] ?? retryBackoffMs.at(-1)!;
}
