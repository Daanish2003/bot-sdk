import { type AnyPgColumn, timestamp, text, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";
import { bot } from "../schema";

/**
 * A Bot's one email address (spec #761): `<bot-name>.<8 random chars>@<inbound domain>`, lowercase.
 * Made the first time the user reads it; a rotation replaces it, so the old address stops at once.
 */
export const channelEmailAddress = chatSchema.table("channel_email_address", {
  botId: uuid("bot_id")
    .primaryKey()
    .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
  address: text("address").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
});
