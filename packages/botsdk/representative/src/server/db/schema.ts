import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { bot, botAssignment, botsdkSchema } from "@botsdk/bot/storage";
import type {
  Draft,
  ReleaseContent,
  TestCheck,
  TestResultStatus,
  TranscriptEntry,
} from "../../shared/contract";

/**
 * A Representative (spec #1167): an agent that speaks for one user's business. It holds the
 * owner's working draft and points at its live Release; on/off is its own, outside every Release.
 */
export const representative = botsdkSchema.table(
  "representative",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** The Bot it reports to; null reports to the owner, which is where a deleted Bot's row leaves it. */
    botId: uuid("bot_id").references((): AnyPgColumn => bot.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** The Release new Turns use. No foreign key: the two tables point at each other. Null until the first approval. */
    liveReleaseId: uuid("live_release_id"),
    draft: jsonb("draft").$type<Draft>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("representative_user_idx").on(table.userId, table.createdAt)],
);

/**
 * A Release: one unchangeable version of a Representative, numbered from 1. Nothing updates a row
 * once it is inserted; rollback only repoints `representative.live_release_id`.
 */
export const representativeRelease = botsdkSchema.table(
  "representative_release",
  {
    id: uuid("id").primaryKey(),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** What the Release pins: job text, switches, Skills, tools, Model, document snapshot and tests. */
    content: jsonb("content").$type<ReleaseContent>().notNull(),
    approvedAt: timestamp("approved_at").defaultNow().notNull(),
    /** Why the owner approved with tests failed or unfinished (ticket #1192); null when they allowed it. */
    overrideReason: text("override_reason"),
  },
  (table) => [unique("representative_release_number").on(table.representativeId, table.number)],
);

/**
 * The result of one of a draft's test conversations (ticket #1192). `draftHash` says which draft it
 * ran on, so it counts only while the draft is still that one. A new run deletes the rows before it.
 */
export const representativeTestResult = botsdkSchema.table(
  "representative_test_result",
  {
    id: uuid("id").primaryKey(),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    draftHash: text("draft_hash").notNull(),
    /** The conversation's place in the draft's `tests`. */
    position: integer("position").notNull(),
    status: text("status").$type<TestResultStatus>().notNull(),
    transcript: jsonb("transcript").$type<TranscriptEntry[]>().notNull(),
    checks: jsonb("checks").$type<TestCheck[]>().notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("representative_test_result_position").on(table.representativeId, table.position),
  ],
);

/**
 * An Assignment a Representative handed to its Bot (`hand_to_bot`), so that choosing another Bot
 * can move the open ones. It goes with the Assignment, and with the Representative.
 */
export const representativeHandOff = botsdkSchema.table(
  "representative_hand_off",
  {
    assignmentId: uuid("assignment_id")
      .primaryKey()
      .references((): AnyPgColumn => botAssignment.id, { onDelete: "cascade" }),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
  },
  (table) => [index("representative_hand_off_representative_idx").on(table.representativeId)],
);
