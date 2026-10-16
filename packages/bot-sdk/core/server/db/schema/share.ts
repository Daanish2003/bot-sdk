import { text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";
import { conversation, message } from "./chat";

/**
 * A Shared link: a pointer at a Conversation's Branch, not a copy of its Messages (ADR 0004).
 * At most one per Conversation; it goes when its Conversation does.
 */
export const sharedLink = chatSchema.table("shared_link", {
  /** 22 random base64url characters (128 bits), separate from any internal id. */
  token: text("token").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .unique()
    .references(() => conversation.id, { onDelete: "cascade" }),
  /** The newest Message of the shared Branch. */
  leafMessageId: uuid("leaf_message_id")
    .notNull()
    .references(() => message.id, { onDelete: "cascade" }),
  /** The Conversation's title when it was shared ("Untitled" without one). */
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /** When the link was last created or updated; the page shows it as the share date. */
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
