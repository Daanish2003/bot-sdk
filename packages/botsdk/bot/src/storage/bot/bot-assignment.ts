import type { AssignmentResult } from "@botsdk/client/bot/assignment";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
 * `blocked` means waiting on a child Assignment.
 */
export const botAssignmentStatus = botsdkSchema.enum("bot_assignment_status", [
  "open",
  "working",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);

/** Who made a change in an Assignment's log: a Bot, the user, or the SDK itself. */
export const botAssignmentActor = botsdkSchema.enum("bot_assignment_actor", [
  "bot",
  "user",
  "system",
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
    /** Reserved: nothing sets it yet. Being overdue is a flag, never a status. */
    overdueAt: timestamp("overdue_at"),
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
  ],
);

/** One append-only row of an Assignment's log: a status change, who made it, and in which Turn. */
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
    at: timestamp("at").notNull(),
  },
  (table) => [index("bot_assignment_log_assignment_id_idx").on(table.assignmentId)],
);
