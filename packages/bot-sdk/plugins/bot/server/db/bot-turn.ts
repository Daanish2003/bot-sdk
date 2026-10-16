import type { ModelMessage } from "@tanstack/ai";
import { type AnyPgColumn, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import type { MessageUsage } from "../../../models/shared/usage";
import { bot } from "./bot";

/** How a Turn stands: `running` until it ends `complete`, `error` or `stopped`. */
export const botTurnStatus = chatSchema.enum("bot_turn_status", [
  "running",
  "complete",
  "error",
  "stopped",
]);

/**
 * One Turn of a Bot: what a user Message started, inside the request. Its `transcript` is the
 * Model's private side of the Turn (its plain text, its SendToUser calls and their results). It is
 * written once when the Turn ends, is replayed as the input of later Turns, and is never a Message.
 */
export const botTurn = chatSchema.table(
  "bot_turn",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    status: botTurnStatus("status").notNull(),
    /** Why an `error` Turn failed. */
    error: text("error"),
    usage: jsonb("usage").$type<MessageUsage>(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    /** The Turn's model messages, after its input. Null until the Turn ends. */
    transcript: jsonb("transcript").$type<ModelMessage[]>(),
  },
  (table) => [index("bot_turn_bot_id_started_at_idx").on(table.botId, table.startedAt.desc())],
);
