import { type AnyPgColumn, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";
import { conversation } from "../schema";

/**
 * A Bot: a name and a Model, talking to its user in one Conversation of kind `bot`. Deleting that
 * Conversation deletes the Bot.
 */
export const bot = chatSchema.table("bot", {
  /** uuidv7, generated in app code. */
  id: uuid("id").primaryKey(),
  /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
  userId: text("user_id").notNull(),
  /** The Bot's one Conversation. */
  conversationId: uuid("conversation_id")
    .notNull()
    .unique()
    .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** The Model the Bot runs on, `"provider:model"`, picked from the `models` plugin's list. */
  model: text("model").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /**
   * The latest rebuild of the user's Computer (`chat.computer.rebuilt_at`) the Bot was told of,
   * or its creation time, since an older rebuild cost it nothing. Null for a Bot from before it.
   */
  computerRebuildSeenAt: timestamp("computer_rebuild_seen_at", { withTimezone: true }),
});
