import { type AnyPgColumn, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import type { RoutineSchedule } from "../../shared/routine";
import { bot } from "./bot";
import { botTurn } from "./bot-turn";

/** How a Routine stands: `pending` until the user's Approval, then `active` or `paused`. */
export const botRoutineState = chatSchema.enum("bot_routine_state", [
  "pending",
  "active",
  "paused",
]);

/**
 * A Routine (#537): a prompt one Bot runs on a schedule, created by the Bot from its Conversation
 * and run only once the user approves it.
 */
export const botRoutine = chatSchema.table(
  "bot_routine",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** A slug the Bot chooses, unique per Bot. */
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** Days of the week at a time, in `timeZone`. */
    schedule: jsonb("schedule").$type<RoutineSchedule>(),
    /** IANA, from the user's newest Message when the Routine was created. */
    timeZone: text("time_zone").notNull(),
    state: botRoutineState("state").notNull(),
    /** The Turn that created the Routine: its approval card sits after that Turn. */
    createdByTurnId: uuid("created_by_turn_id")
      .notNull()
      .references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [uniqueIndex("bot_routine_bot_id_name_idx").on(table.botId, table.name)],
);
