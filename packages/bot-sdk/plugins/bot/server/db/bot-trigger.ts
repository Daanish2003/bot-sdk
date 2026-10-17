import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { conversation, message } from "../../../../core/server/db/schema";
import { botTurn } from "./bot-turn";

/** Who sent a Trigger. Step 3 has only the user; each later wake source adds its own (#502). */
export const botTriggerSource = chatSchema.enum("bot_trigger_source", ["user"]);

/** Where a Trigger came in. Step 3 has only the web app; each later Channel adds its own (#502). */
export const botTriggerChannel = chatSchema.enum("bot_trigger_channel", ["web"]);

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
    /** The Turn that took the Trigger; null while it waits in the Conversation queue. */
    turnId: uuid("turn_id").references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at").notNull(),
  },
  (table) => [
    index("bot_trigger_conversation_id_received_at_idx").on(table.conversationId, table.receivedAt),
  ],
);
