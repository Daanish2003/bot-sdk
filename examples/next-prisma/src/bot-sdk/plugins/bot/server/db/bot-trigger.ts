import { isNull } from "drizzle-orm";
import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { conversation, message } from "../../../../core/server/db/schema";
import { botTurn } from "./bot-turn";

/** Who sent a Trigger: the user, one of the Bot's Routines, or a Check-in it set (#539). */
export const botTriggerSource = chatSchema.enum("bot_trigger_source", [
  "user",
  "routine",
  "check_in",
]);

/** Where a Trigger came in: the web app, a schedule, or an inbound webhook (#539). */
export const botTriggerChannel = chatSchema.enum("bot_trigger_channel", [
  "web",
  "schedule",
  "webhook",
]);

/**
 * One Trigger the Router received for a Conversation (#499). Untaken (`turn_id` null), it waits in
 * the Conversation queue; the Turn that takes it sets `turn_id`. A Turn's provenance is the Triggers
 * it took.
 */
export const botTrigger = chatSchema.table(
  "bot_trigger",
  {
    /** The source's unique ID; for the user's Messages, the Message's id. */
    id: text("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    source: botTriggerSource("source").notNull(),
    channel: botTriggerChannel("channel").notNull(),
    /** The Message the Trigger carries, when it carries one. */
    messageId: uuid("message_id").references((): AnyPgColumn => message.id, {
      onDelete: "set null",
    }),
    /**
     * What a Trigger that carries no Message gives the Model: a wake notice and a snapshot taken when
     * it fired, such as a Routine's prompt, so an edit made later never changes it.
     */
    text: text("text"),
    /** The Turn that took the Trigger; null while it waits in the Conversation queue. */
    turnId: uuid("turn_id").references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at").notNull(),
  },
  (table) => [
    // The Conversation queue: the Triggers no Turn has taken yet.
    index("bot_trigger_waiting_idx")
      .on(table.conversationId, table.receivedAt)
      .where(isNull(table.turnId)),
    index("bot_trigger_turn_id_idx").on(table.turnId),
  ],
);
