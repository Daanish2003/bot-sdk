import { boolean, text } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** A user's Memory switch; a user without a row has Memory on (ADR 0022). */
export const memorySettings = chatSchema.table("memory_settings", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** Whether the Bots' memory is used and made for this user (ADR 0022). */
  enabled: boolean("enabled").notNull().default(true),
});
