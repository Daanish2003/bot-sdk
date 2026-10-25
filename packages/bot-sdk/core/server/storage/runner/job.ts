import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";
import type { HistoryKind } from "../../../../plugins/runner/server/internal";

/** Where a background job is. `queued` and `running` are active (ADR 0011). */
export const jobStatus = chatSchema.enum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * One background job (ADR 0011): claimed by a process with `FOR UPDATE SKIP LOCKED`, retried with
 * backoff through `run_after`, and failed once its attempts are used up. No foreign keys: a job
 * names its own rows through its payload.
 */
export const job = chatSchema.table(
  "job",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    payload: jsonb("payload").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** A queued job is claimed once this has passed; a retry sets it to the backoff. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Unique among active jobs only, so a key can be reused once its job has ended. */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("job_idempotency_key_active_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.status} in ('queued', 'running')`),
    // `text_pattern_ops` lets a prefix `LIKE` (a Routine's `routine:<id>:%`) use the index under any collation.
    index("job_idempotency_key_prefix_idx").using(
      "btree",
      table.idempotencyKey.op("text_pattern_ops"),
    ),
    index("job_claim_idx").on(table.status, table.runAfter),
  ],
);

export type JobRow = typeof job.$inferSelect;

/**
 * A job's history (ADR 0011, the #481 amendment): what its workflow recorded, in call order. A
 * retried or re-claimed job replays its code against these rows and carries on after the last one.
 * Pruning the job removes them.
 */
export const jobEvent = chatSchema.table(
  "job_event",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    /** The call's place in the workflow, from 1. Replay matches calls to entries by it. */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull().$type<HistoryKind>(),
    /** The activity's or the patch's name; empty for `now` and `random`. */
    name: text("name").notNull(),
    /** An activity's JSON result (its Checkpoint), the time or number returned, or null. */
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.seq] })],
);

export type JobEventRow = typeof jobEvent.$inferSelect;
