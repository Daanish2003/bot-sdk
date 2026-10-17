import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "../../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";
import { job } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { NonDeterminismError, WorkflowYieldedError, createWorkflow } from "../workflow/engine";
import { JOB_TIMING, PermanentJobError, backoffAfter, registeredJob } from "./define";
import { heartbeatJob, jobHistoryStore, loadHistory, ownAttempt } from "./history";
import type { JobClock } from "./in-process";
import type { EnqueueOptions, JobStatus } from "./runner";

type Logger = Pick<Console, "error">;

const ACTIVE = ["queued", "running"] as const;

/** A job a process has claimed and is about to run. */
export type ClaimedJob = {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

/**
 * Stores a queued job, in `db` or a transaction, and returns its id. A second enqueue with an
 * active key stores nothing and returns the id of the job that holds the key.
 */
export async function enqueueJob(
  db: Database | Transaction,
  name: string,
  payload: unknown,
  options: EnqueueOptions & { now: Date },
): Promise<string> {
  const definition = registeredJob(name);
  if (!definition) throw new Error(`No job named "${name}" is defined`);
  const { now, idempotencyKey, runAfter = now } = options;
  const id = uuidv7(now.getTime());
  const inserted = await db
    .insert(job)
    .values({
      id,
      name,
      payload: definition.payload.parse(payload),
      idempotencyKey,
      runAfter,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: job.id });
  if (inserted.length > 0 || idempotencyKey === undefined) return id;

  // Only an active job with this key can have made the insert conflict.
  const [active] = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.idempotencyKey, idempotencyKey), inArray(job.status, [...ACTIVE])));
  if (!active) throw new Error(`The job with key "${idempotencyKey}" changed while it was queued`);
  return active.id;
}

/**
 * Takes the next queued job, marking it running and counting the attempt. `FOR UPDATE SKIP LOCKED`
 * keeps two processes from taking the same job. `respectRunAfter: false` ignores the backoff.
 */
export async function claimJob(
  db: Database,
  now: Date,
  { respectRunAfter = true }: { respectRunAfter?: boolean } = {},
): Promise<ClaimedJob | undefined> {
  const due = respectRunAfter ? sql`and run_after <= ${now}` : sql``;
  const { rows } = await db.execute<{
    id: string;
    name: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }>(sql`
    update chat.job
    set status = 'running', attempts = attempts + 1, heartbeat_at = ${now}, updated_at = ${now}
    where id = (
      select id from chat.job
      where status = 'queued' ${due}
      order by run_after, created_at
      limit 1
      for update skip locked
    )
    returning id, name, payload, attempts, max_attempts`);
  const [row] = rows;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Records how an attempt ended: succeeded, handed back after it yielded, retried after backoff, or
 * failed (on the last attempt or a `PermanentJobError` or `NonDeterminismError`, which runs
 * `onFailed`). An attempt that has lost its row writes nothing.
 */
async function recordOutcome(
  db: Database,
  claimed: ClaimedJob,
  failure: { error: unknown } | undefined,
  { now, logger, deps }: { now: Date; logger: Logger; deps: BotSdkContext },
): Promise<void> {
  if (!failure) {
    await db.update(job).set({ status: "succeeded", updatedAt: now }).where(ownAttempt(claimed));
    return;
  }

  const { error } = failure;
  if (error instanceof WorkflowYieldedError) {
    // A deploy: queued again for any process to resume at once, and the attempt doesn't count.
    await db
      .update(job)
      .set({ status: "queued", runAfter: now, attempts: sql`${job.attempts} - 1`, updatedAt: now })
      .where(ownAttempt(claimed));
    return;
  }
  const lastError = error instanceof Error ? error.message : String(error);
  const final =
    error instanceof PermanentJobError ||
    error instanceof NonDeterminismError ||
    claimed.attempts >= claimed.maxAttempts;
  if (!final) {
    await db
      .update(job)
      .set({
        status: "queued",
        runAfter: new Date(now.getTime() + backoffAfter(claimed.attempts)),
        lastError,
        updatedAt: now,
      })
      .where(ownAttempt(claimed));
    return;
  }

  const ended = await db
    .update(job)
    .set({ status: "failed", lastError, updatedAt: now })
    .where(ownAttempt(claimed))
    .returning({ id: job.id });
  if (ended.length === 0) return;
  try {
    await registeredJob(claimed.name)?.onFailed?.(claimed.payload, error, deps);
  } catch (onFailedError) {
    logger.error(`onFailed for job "${claimed.name}" failed`, onFailedError);
  }
}

/**
 * Runs a claimed job and resolves once its outcome is decided. While it runs, the attempt
 * heartbeats every `JOB_TIMING.heartbeatMs`. It ends in one of these ways:
 *
 * - the handler settles, and the outcome is recorded (see `recordOutcome`);
 * - the attempt passes `JOB_TIMING.attemptCapMs`, which is a failure and is recorded;
 * - a heartbeat or a history save finds the row gone (cancelled, or re-queued after a lost lease),
 *   so the handler is aborted and nothing is written;
 * - `drain` aborts (a deploy's `stop()`), so the workflow yields at its next Checkpoint and the
 *   row is handed back `queued` without counting the attempt, for another process to resume;
 * - `shutdown` aborts, so the handler is aborted and nothing is written. The lease is left to
 *   expire, and another process re-runs the job.
 */
export async function runClaimedJob(
  db: Database,
  claimed: ClaimedJob,
  {
    clock,
    logger,
    deps,
    drain,
    shutdown,
  }: {
    clock: JobClock;
    logger: Logger;
    deps: () => BotSdkContext;
    drain?: AbortSignal;
    shutdown?: AbortSignal;
  },
): Promise<void> {
  const definition = registeredJob(claimed.name);
  const attempt = new AbortController();
  const startedAt = clock.now().getTime();
  let heartbeat: unknown;
  let decided = false;
  let concluded!: () => void;
  const done = new Promise<void>((resolve) => {
    concluded = resolve;
  });

  // Stops the heartbeat and the shutdown listener. Once `decided`, the attempt writes nothing more.
  const release = () => {
    decided = true;
    clock.clearInterval(heartbeat);
    heartbeat = undefined;
    shutdown?.removeEventListener("abort", onShutdown);
  };
  const onShutdown = () => {
    if (decided) return;
    release();
    attempt.abort(new Error("The runner is shutting down"));
    concluded();
  };
  const settle = async (failure?: { error: unknown }) => {
    if (decided) return;
    release();
    try {
      await recordOutcome(db, claimed, failure, { now: clock.now(), logger, deps: deps() });
    } catch (error) {
      logger.error(`Recording the outcome of job "${claimed.name}" failed`, error);
    }
    concluded();
  };
  const beat = async () => {
    if (decided) return;
    if (clock.now().getTime() - startedAt >= JOB_TIMING.attemptCapMs) {
      attempt.abort(new Error("The attempt ran too long"));
      await settle({
        error: new Error(`Timed out after ${JOB_TIMING.attemptCapMs / 60_000} minutes`),
      });
      return;
    }
    const held = await heartbeatJob(db, claimed, clock.now()).catch((error: unknown) => {
      logger.error(`Heartbeat for job "${claimed.name}" failed`, error);
      return true;
    });
    if (held) return;
    lose("The job was cancelled");
  };
  // The attempt no longer owns its row: abort the handler and write nothing more.
  const lose = (reason: string) => {
    if (decided) return;
    release();
    attempt.abort(new Error(reason));
    concluded();
  };

  heartbeat = clock.setInterval(() => void beat(), JOB_TIMING.heartbeatMs);
  if (shutdown?.aborted) onShutdown();
  else shutdown?.addEventListener("abort", onShutdown, { once: true });
  if (!decided) {
    const run = (async () => {
      if (!definition) throw new Error(`No job named "${claimed.name}" is defined`);
      // A retried or re-claimed job replays its history and carries on after its last entry.
      const workflow = createWorkflow({
        history: await loadHistory(db, claimed.id),
        store: jobHistoryStore(db, claimed, clock.now),
        now: clock.now,
        signal: attempt.signal,
        yieldSignal: drain,
        onLost: () => lose("The attempt no longer owns its job"),
      });
      try {
        await definition.run(definition.payload.parse(claimed.payload), {
          ...workflow.context,
          signal: attempt.signal,
          deps: deps(),
        });
      } catch (error) {
        throw workflow.raised() ?? error;
      }
      workflow.finish();
    })();
    run.then(
      () => settle(),
      (error: unknown) => settle({ error }),
    );
  }
  await done;
}

/**
 * Re-queues the running jobs whose lease has expired, because the process running them stopped
 * (ADR 0011). The attempt already counted when the job was claimed, so a job on its last attempt
 * fails here instead, and its `onFailed` runs.
 */
export async function reapStaleJobs(
  db: Database,
  now: Date,
  logger: Logger,
  deps: BotSdkContext,
): Promise<void> {
  const cutoff = new Date(now.getTime() - JOB_TIMING.leaseMs);
  const expired = and(
    eq(job.status, "running"),
    or(isNull(job.heartbeatAt), lt(job.heartbeatAt, cutoff)),
  );
  const lastError = "Its lease expired: the process running it stopped";
  await db
    .update(job)
    .set({ status: "queued", runAfter: now, lastError, updatedAt: now })
    .where(and(expired, lt(job.attempts, job.maxAttempts)));
  const lost = await db
    .update(job)
    .set({ status: "failed", lastError, updatedAt: now })
    .where(and(expired, gte(job.attempts, job.maxAttempts)))
    .returning({ name: job.name, payload: job.payload });
  for (const row of lost) {
    try {
      await registeredJob(row.name)?.onFailed?.(row.payload, new Error(lastError), deps);
    } catch (onFailedError) {
      logger.error(`onFailed for job "${row.name}" failed`, onFailedError);
    }
  }
}

/**
 * Cancels the queued job with this key, or the running one at its next heartbeat or, sooner, at its
 * next Checkpoint, whose save is fenced.
 */
export async function cancelJob(db: Database, idempotencyKey: string, now: Date): Promise<void> {
  await db
    .update(job)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(job.idempotencyKey, idempotencyKey), inArray(job.status, [...ACTIVE])));
}

/**
 * Cancels the active job with this key in the caller's transaction, and returns what it was:
 * `queued` (it never runs) or `running` (its attempt aborts at its next heartbeat or write).
 * Returns undefined when no job with this key is active.
 */
export async function cancelJobIn(
  tx: Transaction,
  idempotencyKey: string,
  now: Date,
): Promise<"queued" | "running" | undefined> {
  const [active] = await tx
    .select({ id: job.id, status: job.status })
    .from(job)
    .where(and(eq(job.idempotencyKey, idempotencyKey), inArray(job.status, [...ACTIVE])))
    .for("update");
  if (!active) return undefined;
  await tx.update(job).set({ status: "cancelled", updatedAt: now }).where(eq(job.id, active.id));
  return active.status === "queued" ? "queued" : "running";
}

/** Deletes succeeded and cancelled jobs ended over 7 days ago, and failed ones over 30 days ago. */
export async function pruneFinishedJobs(db: Database, now: Date): Promise<void> {
  await db
    .delete(job)
    .where(
      or(
        and(
          inArray(job.status, ["succeeded", "cancelled"]),
          lt(job.updatedAt, new Date(now.getTime() - JOB_TIMING.retainDoneMs)),
        ),
        and(
          eq(job.status, "failed"),
          lt(job.updatedAt, new Date(now.getTime() - JOB_TIMING.retainFailedMs)),
        ),
      ),
    );
}

/** A job's state, or undefined once it has been pruned or never existed. */
export async function readJob(db: Database, id: string): Promise<JobStatus | undefined> {
  const [row] = await db.select().from(job).where(eq(job.id, id));
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    runAfter: row.runAfter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
