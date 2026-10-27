import type { z } from "zod";

import type { FeatureContext } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import type { WorkflowContext } from "../workflow/engine";

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

/**
 * What only the core's own jobs set. Jobs with one `budget` share their `concurrency` budget, as
 * the Helpers and the Demonstration captures do (#602); without it, a job's budget is its own.
 */
type CoreOnly = { budget?: string };

/** One of the core's own jobs. */
export type CoreJobDefinition<P> = JobDefinition<P, CoreJobServices> & CoreOnly;

/** Declares one of the core's own jobs, whose context and hooks get the core context as `deps`. */
export function defineCoreJob<P>(definition: CoreJobDefinition<P>): CoreJobDefinition<P> {
  return definition;
}

/**
 * A concurrency budget: at most `concurrency` of the jobs it names run at once in one process. Its
 * `key` is the jobs' `budget`, or the name of the one job that has none.
 */
export type JobBudget = { key: string; names: string[]; concurrency: number };

/** The budgets of the jobs with a `concurrency`, one per `budget` key, or per job without one. */
export function budgetsOf(jobs: JobTable): JobBudget[] {
  const budgets = new Map<string, JobBudget>();
  for (const { definition } of jobs.values()) {
    const { name, concurrency } = definition;
    if (concurrency === undefined) continue;
    const key = definition.budget ?? name;
    const budget = budgets.get(key);
    if (!budget) budgets.set(key, { key, names: [name], concurrency });
    else if (budget.concurrency === concurrency) budget.names.push(name);
    else throw new Error(`The jobs of the budget "${key}" have different concurrencies`);
  }
  return [...budgets.values()];
}

/** A job as an instance's runner holds it: its payload type erased, with its services. */
export type JobEntry = {
  // oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload and services
  definition: JobDefinition<unknown, any> & CoreOnly;
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
      const { concurrency } = definition;
      if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) {
        throw new Error(
          `The job "${definition.name}" has a concurrency of ${concurrency}: it must be a whole number above 0`,
        );
      }
      table.set(definition.name, { definition, services });
    }
  }
  return table;
}

/** Milliseconds to wait before attempt 2, 3, and so on: about 10 s, 1 min, then 5 min. */
const retryBackoffMs = [10_000, 60_000, 300_000];

/** The wait before the next attempt, once `attempts` have failed. */
export function backoffAfter(attempts: number): number {
  return retryBackoffMs[Math.min(attempts, retryBackoffMs.length) - 1] ?? retryBackoffMs.at(-1)!;
}

const DAY_MS = 86_400_000;

/** Lease, heartbeat and retention for `botsdk.job` (ADR 0011). */
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
