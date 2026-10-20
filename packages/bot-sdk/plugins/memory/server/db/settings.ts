import { boolean, text } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** A user's Memory switch; a user without a row has Memory on (ADR 0013, its #616 amendment). */
export const memorySettings = chatSchema.table("memory_settings", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** Whether Memory is used and made for this user: the assistant's Memories and the Bots' memory. */
  enabled: boolean("enabled").notNull().default(true),
});
