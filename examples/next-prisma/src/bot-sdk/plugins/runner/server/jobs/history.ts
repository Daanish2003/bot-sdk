import { and, asc, eq } from "drizzle-orm";

import type { Database } from "../../../../core/server/db/index";
import type { Transaction } from "../../../../core/server/plugin";
import { job, jobEvent } from "../../../../core/server/db/schema";
import type { HistoryEntry, HistoryStore } from "../workflow/engine";
import type { ClaimedJob } from "./store";

/** Matches the row only while this attempt still owns it. */
export function ownAttempt(claimed: Pick<ClaimedJob, "id" | "attempts">) {
  return and(eq(job.id, claimed.id), eq(job.status, "running"), eq(job.attempts, claimed.attempts));
}

/**
 * Writes the heartbeat, in `db` or a transaction. False when the attempt no longer holds its row:
 * cancelled or re-queued.
 */
export async function heartbeatJob(
  db: Database | Transaction,
  claimed: Pick<ClaimedJob, "id" | "attempts">,
  now: Date,
): Promise<boolean> {
  const held = await db
    .update(job)
    .set({ heartbeatAt: now })
    .where(ownAttempt(claimed))
    .returning({ id: job.id });
  return held.length > 0;
}

/** A job's recorded history, in seq order. */
export async function loadHistory(db: Database, jobId: string): Promise<HistoryEntry[]> {
  const rows = await db
    .select({
      seq: jobEvent.seq,
      kind: jobEvent.kind,
      name: jobEvent.name,
      result: jobEvent.result,
    })
    .from(jobEvent)
    .where(eq(jobEvent.jobId, jobId))
    .orderBy(asc(jobEvent.seq));
  return rows;
}

/** Rolls back a save whose attempt no longer owns its job. */
class Fenced extends Error {}

/**
 * Saves a claimed job's history entries. Each save is one transaction that writes only while this
 * attempt still owns the row (the `ownAttempt` fence) and bumps `heartbeat_at`, so every save also
 * renews the lease (ADR 0011, the #481 amendment).
 */
export function jobHistoryStore(
  db: Database,
  claimed: ClaimedJob,
  now: () => Date,
): HistoryStore<Transaction> {
  const saveWith: HistoryStore<Transaction>["saveWith"] = async (entry, fn) => {
    try {
      const result = await db.transaction(async (tx) => {
        const result = await fn(tx);
        const at = now();
        if (!(await heartbeatJob(tx, claimed, at))) throw new Fenced();
        await tx.insert(jobEvent).values({ jobId: claimed.id, ...entry, result, createdAt: at });
        return result;
      });
      return { saved: true, result };
    } catch (error) {
      if (error instanceof Fenced) return { saved: false };
      throw error;
    }
  };
  return {
    save: async ({ result, ...entry }) => (await saveWith(entry, async () => result)).saved,
    saveWith,
  };
}

/**
 * A store that records nothing, for a job run with no `chat.job` row (a Host's worker, such as a
 * Trigger.dev task): every call runs for real. A `(tx) =>` activity still gets a transaction.
 */
export function unrecordedStore(db: Database): HistoryStore<Transaction> {
  return {
    save: async () => true,
    saveWith: async (_entry, fn) => ({ saved: true, result: await db.transaction(fn) }),
  };
}
