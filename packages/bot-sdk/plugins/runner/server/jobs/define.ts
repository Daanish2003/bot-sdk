import type { z } from "zod";

import type { FeatureContext } from "../../../../core/server/feature";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";
import type { Database } from "../../../../core/server/storage";
import { createWorkflow, type WorkflowContext } from "../workflow/engine";
import { unrecordedStore } from "./history";

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

/**
 * What a job's `run` gets besides its payload (spec #872): the workflow context (ADR 0011, the
 * #481 amendment), whose `step`, `now`, `random` and `patched` are recorded in the job's history and
 * replayed when the job is retried or re-claimed (code outside them reruns on every attempt), the
 * `signal` that aborts at the next heartbeat after a cancel, and the core services the job was
 * registered with: a feature's job gets its feature's context, a Host's job the Host's.
 */
export type JobContext<Services extends object = FeatureContext> = WorkflowContext<Transaction> & {
  signal: AbortSignal;
} & Services;

/**
 * A job, as `defineJob` takes it (spec #872). It runs only on an instance that lists it: a
 * feature's `jobs`, or the factory's `jobs` option for the Host's.
 */
export type JobDefinition<P, Services extends object = FeatureContext> = {
  name: string;
  payload: z.ZodType<P>;
  run: (payload: P, context: JobContext<Services>) => Promise<void>;
  /** Runs once, after the final failure (the last attempt, or a `PermanentJobError`). */
  onFailed?: (payload: P, error: unknown, services: Services) => Promise<void> | void;
  /**
   * Runs once, from the lease sweep, for a cancelled job whose attempt lost its lease before its
   * handler ended (a crash). An attempt that sees the cancel and ends leaves it to the handler.
   */
  onCancelled?: (payload: P, services: Services) => Promise<void> | void;
  /**
   * At most this many of the job run at once in one process, in a budget of their own, so a slow
   * job never takes the others' slots (#602). Without it, the job shares the Executor's budget.
   */
  concurrency?: number;
};

/** What the core's own jobs (the Bots', the Computer's) get: the whole core context. */
export type CoreJobServices = { deps: BotSdkContext };

/** Declares a job (spec #872). Nothing registers it: an instance runs the jobs it lists. */
export function defineJob<P, Services extends object = FeatureContext>(
  definition: JobDefinition<P, Services>,
): JobDefinition<P, Services> {
  return definition;
}

/** Declares one of the core's own jobs, whose context and hooks get the core context as `deps`. */
export function defineCoreJob<P>(
  definition: JobDefinition<P, CoreJobServices>,
): JobDefinition<P, CoreJobServices> {
  return definition;
}

/** A job as an instance's runner holds it: its payload type erased, with its services. */
export type JobEntry = {
  // oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload and services
  definition: JobDefinition<unknown, any>;
  /** What its context, `onFailed` and `onCancelled` get. */
  services: object;
};

/** An instance's jobs, by name. */
export type JobTable = ReadonlyMap<string, JobEntry>;

/** The jobs of each group, by name, each with its group's services. A name can be listed once. */
export function jobTable(
  // oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload
  groups: Iterable<{ jobs: readonly JobDefinition<any, any>[]; services: object }>,
): JobTable {
  const table = new Map<string, JobEntry>();
  for (const { jobs, services } of groups) {
    for (const definition of jobs) {
      if (table.has(definition.name)) {
        throw new Error(`A job named "${definition.name}" is defined twice`);
      }
      table.set(definition.name, { definition, services });
    }
  }
  return table;
}

/**
 * Runs a listed job's handler in this process, with its payload validated against the job's
 * schema. `chat.runner.runJob` calls it, so a Host's own worker (such as a Trigger.dev task) can run a job.
 * Errors reach the caller, which decides about retries. With no `chat.job` row, nothing is
 * recorded: every workflow call runs for real.
 */
export async function runRegisteredJob(
  name: string,
  payload: unknown,
  { jobs, db, clock }: { jobs: JobTable; db: Database; clock: () => Date },
): Promise<void> {
  const entry = jobs.get(name);
  if (!entry) throw new Error(`Unknown job "${name}"`);
  const job = entry.definition;
  const parsed = job.payload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Job "${name}" got an invalid payload: ${parsed.error.message}`);
  }
  const workflow = createWorkflow({
    history: [],
    store: unrecordedStore(db),
    now: clock,
  });
  await job.run(parsed.data, {
    ...entry.services,
    ...workflow.context,
    signal: new AbortController().signal,
  });
}

/** Milliseconds to wait before attempt 2, 3, and so on: about 10 s, 1 min, then 5 min. */
const retryBackoffMs = [10_000, 60_000, 300_000];

/** The wait before the next attempt, once `attempts` have failed. */
export function backoffAfter(attempts: number): number {
  return retryBackoffMs[Math.min(attempts, retryBackoffMs.length) - 1] ?? retryBackoffMs.at(-1)!;
}

const DAY_MS = 86_400_000;

/** Lease, heartbeat and retention for `chat.job` (ADR 0011). */
export const JOB_TIMING = {
  /** A running job writes `heartbeat_at` this often. */
  heartbeatMs: 10_000,
  /** A running job whose heartbeat is older than this has lost its lease. */
  leaseMs: 60_000,
  /** The longest one attempt may run before it is ended and counted as a failure. */
  attemptCapMs: 15 * 60_000,
  /** Succeeded and cancelled jobs are deleted this long after they end. */
  retainDoneMs: 7 * DAY_MS,
  /** Failed jobs are deleted this long after they end. */
  retainFailedMs: 30 * DAY_MS,
} as const;
