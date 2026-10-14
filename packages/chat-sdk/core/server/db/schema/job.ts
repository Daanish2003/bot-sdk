import { sql } from "drizzle-orm";
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

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
    index("job_claim_idx").on(table.status, table.runAfter),
  ],
);

export type JobRow = typeof job.$inferSelect;
