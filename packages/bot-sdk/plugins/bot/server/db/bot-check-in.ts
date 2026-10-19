import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { bot } from "./bot";
import { botTurn } from "./bot-turn";

/** How a Check-in stands: `pending` until it fires once or the Bot or the user cancels it. */
export const botCheckInState = chatSchema.enum("bot_check_in_state", [
  "pending",
  "fired",
  "cancelled",
]);

/**
 * A Check-in (#540): one moment a Bot sets for itself, with a note to its future self. It needs no
 * Approval and fires once.
 */
export const botCheckIn = chatSchema.table(
  "bot_check_in",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** When it fires. */
    at: timestamp("at").notNull(),
    note: text("note").notNull(),
    state: botCheckInState("state").notNull(),
    /** The Turn that set it: its inline line sits after that Turn. */
    createdByTurnId: uuid("created_by_turn_id")
      .notNull()
      .references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("bot_check_in_bot_id_idx").on(table.botId)],
);
