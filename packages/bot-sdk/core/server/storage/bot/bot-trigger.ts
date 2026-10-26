import { isNull } from "drizzle-orm";
import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { conversation, message } from "../schema";
import { botTurn } from "./bot-turn";

/** Who sent a Trigger: the user, one of the Bot's Routines, a Check-in it set (#539), or a Helper (#565). */
export const botTriggerSource = botsdkSchema.enum("bot_trigger_source", [
  "user",
  "routine",
  "check_in",
  "helper",
]);

/**
 * Where a Trigger came in: the web app, a schedule, an inbound webhook (#539), a Helper's report
 * (#565), or an email to the Bot's address (spec #761).
 */
export const botTriggerChannel = botsdkSchema.enum("bot_trigger_channel", [
  "web",
  "schedule",
  "webhook",
  "helper",
  "email",
]);

/**
 * One Trigger the Router received for a Conversation (#499). Untaken (`turn_id` null), it waits in
 * the Conversation queue; the Turn that takes it sets `turn_id`. A Turn's provenance is the Triggers
 * it took.
 */
export const botTrigger = botsdkSchema.table(
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
