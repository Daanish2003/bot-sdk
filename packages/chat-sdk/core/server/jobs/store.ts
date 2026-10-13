import { eq, sql } from "drizzle-orm";

import type { AppDeps } from "../deps";
import type { Database } from "../db/index";
import { job } from "../db/schema/job";
import { uuidv7 } from "../lib/uuidv7";
import { PermanentJobError, backoffAfter, registeredJob } from "./define";
import type { EnqueueOptions } from "./runner";

type Logger = Pick<Console, "error">;

/** A job a process has claimed and is about to run. */
export type ClaimedJob = {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

/** Stores a queued job. A second enqueue with an active key does nothing. */
export async function enqueueJob(
  db: Database,
  name: string,
  payload: unknown,
  options: EnqueueOptions & { now: Date },
): Promise<void> {
  const definition = registeredJob(name);
  if (!definition) throw new Error(`No job named "${name}" is defined`);
  const { now, idempotencyKey, runAfter = now } = options;
  await db
    .insert(job)
    .values({
      id: uuidv7(now.getTime()),
      name,
      payload: definition.payload.parse(payload),
      idempotencyKey,
      runAfter,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
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
 * Runs a claimed job and records its outcome. Success ends it `succeeded`. A failure is retried
 * after backoff while attempts remain, and otherwise (or on a `PermanentJobError`) ends it `failed`
 * and runs `onFailed`.
 */
export async function runClaimedJob(
  db: Database,
  claimed: ClaimedJob,
  { now, logger, deps }: { now: () => Date; logger: Logger; deps: AppDeps },
): Promise<void> {
  const definition = registeredJob(claimed.name);
  let failure: { error: unknown } | undefined;
  try {
    if (!definition) throw new Error(`No job named "${claimed.name}" is defined`);
    await definition.run(definition.payload.parse(claimed.payload), deps);
  } catch (error) {
    failure = { error };
  }

  const at = now();
  if (!failure) {
    await db.update(job).set({ status: "succeeded", updatedAt: at }).where(eq(job.id, claimed.id));
    return;
  }

  const { error } = failure;
  const lastError = error instanceof Error ? error.message : String(error);
  const final = error instanceof PermanentJobError || claimed.attempts >= claimed.maxAttempts;
  if (!final) {
    await db
      .update(job)
      .set({
        status: "queued",
        runAfter: new Date(at.getTime() + backoffAfter(claimed.attempts)),
        lastError,
        updatedAt: at,
      })
      .where(eq(job.id, claimed.id));
    return;
  }

  await db
    .update(job)
    .set({ status: "failed", lastError, updatedAt: at })
    .where(eq(job.id, claimed.id));
  try {
    await definition?.onFailed?.(claimed.payload, error, deps);
  } catch (onFailedError) {
    logger.error(`onFailed for job "${claimed.name}" failed`, onFailedError);
  }
}
