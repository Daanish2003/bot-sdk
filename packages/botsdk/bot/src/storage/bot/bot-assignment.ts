import {
  type AssignmentResult,
  defaultAssignmentCallLimit,
  defaultAssignmentMoneyLimitMicros,
} from "@botsdk/client/bot/assignment";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { bot } from "./bot";

/**
 * How an Assignment stands (spec #1166): `open` until a Turn of its Bot takes it, then `working`.
 * Only its Bot's `finish_assignment` call makes it `done` or `failed`; a Turn ending never does.
 * `blocked` means waiting on a child Assignment or on the owner.
 */
export const botAssignmentStatus = botsdkSchema.enum("bot_assignment_status", [
  "open",
  "working",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);

/** Who made a change in an Assignment's log: a Bot, the user, the feature that assigned it, or the SDK. */
export const botAssignmentActor = botsdkSchema.enum("bot_assignment_actor", [
  "bot",
  "user",
  "system",
  "feature",
]);

/** An Assignment (spec #1166): one piece of work handed to a Bot, with no Room needed. */
export const botAssignment = botsdkSchema.table(
  "bot_assignment",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Bot doing the work. */
    assignedBotId: uuid("assigned_bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The Bot that handed it over, which wakes with the result; null once that Bot is gone. */
    assignerBotId: uuid("assigner_bot_id").references((): AnyPgColumn => bot.id, {
      onDelete: "set null",
    }),
    /** The feature that handed it over, by id (ticket #1185); it has no Bot as assigner then. */
    assignerFeature: text("assigner_feature"),
    /** The feature's job the core queues, in the transaction that ends the Assignment. */
    assignerJob: text("assigner_job"),
    /**
     * Whether the assigner's text is a Bot's, read like a Room handoff. False for a feature's, and
     * for a Bot's that split it off from untrusted work: it reaches the Bot as untrusted data (ADR
     * 0021), down the whole chain, and never counts as the user's word.
     */
    assignerTrusted: boolean("assigner_trusted").notNull().default(true),
    /** The Assignment this one was split off from, held by the Bot that assigned this one. */
    parentAssignmentId: uuid("parent_assignment_id").references(
      (): AnyPgColumn => botAssignment.id,
      {
        onDelete: "set null",
      },
    ),
    /**
     * How long the chain of Assignments is up to here, this one included, at most
     * `assignmentChainLimit`. Kept, as a chain also runs through a result that wakes a Bot, with no
     * parent to follow.
     */
    depth: integer("depth").notNull().default(1),
    /** A few words naming the work, as its collapsed item shows it. */
    title: text("title").notNull(),
    /** The work itself, in the assigner's words. */
    instructions: text("instructions").notNull(),
    status: botAssignmentStatus("status").notNull(),
    /** What its Bot finished it with, set exactly when it is `done` or `failed`. */
    result: jsonb("result").$type<AssignmentResult>(),
    /** When a feature flagged it overdue (`markOverdue`). Being overdue is a flag, never a status. */
    overdueAt: timestamp("overdue_at"),
    /**
     * The budget (#1184): how many model calls, and how much money where a price is known, may be
     * spent on it and what has been. Only an Assignment with no parent uses these: its descendants
     * draw from it, so a child's stay at their defaults.
     */
    callLimit: integer("call_limit").notNull().default(defaultAssignmentCallLimit),
    /** In millionths of a US dollar. */
    moneyLimitMicros: bigint("money_limit_micros", { mode: "number" })
      .notNull()
      .default(defaultAssignmentMoneyLimitMicros),
    callsSpent: integer("calls_spent").notNull().default(0),
    microsSpent: bigint("micros_spent", { mode: "number" }).notNull().default(0),
    /** When it moved to `blocked` over budget, until the owner raises the limit. */
    overBudgetAt: timestamp("over_budget_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("bot_assignment_assigned_bot_id_idx").on(table.assignedBotId),
    index("bot_assignment_assigner_bot_id_idx").on(table.assignerBotId),
    index("bot_assignment_parent_assignment_id_idx").on(table.parentAssignmentId),
    check(
      "bot_assignment_result_check",
      sql`(${table.status} in ('done', 'failed')) = (${table.result} is not null)`,
    ),
    check(
      "bot_assignment_assigner_feature_check",
      sql`(${table.assignerFeature} is null) = (${table.assignerJob} is null)`,
    ),
    check(
      "bot_assignment_assigner_trusted_check",
      sql`${table.assignerFeature} is null or not ${table.assignerTrusted}`,
    ),
  ],
);

/**
 * One append-only row of an Assignment's log, but for its note being redacted: a status change, who
 * made it, and in which Turn.
 */
export const botAssignmentLog = botsdkSchema.table(
  "bot_assignment_log",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references((): AnyPgColumn => botAssignment.id, { onDelete: "cascade" }),
    /** The status it moved to. */
    status: botAssignmentStatus("status").notNull(),
    actor: botAssignmentActor("actor").notNull(),
    /**
     * The Bot that made it, when `actor` is `bot`. No foreign key, here or on `turnId`: a row never
     * changes, so it keeps the id of what it names even once that is gone.
     */
    actorBotId: uuid("actor_bot_id"),
    note: text("note"),
    /** The Turn it happened in, when one did. */
    turnId: uuid("turn_id"),
    /** On a spend row (#1184): the model calls it records, which leave the status as it was. */
    calls: integer("calls"),
    /** On a spend row: what those calls cost, in millionths of a US dollar. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    at: timestamp("at").notNull(),
  },
  (table) => [index("bot_assignment_log_assignment_id_idx").on(table.assignmentId)],
);
