import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { conversation } from "../schema";
import { bot } from "./bot";

/**
 * One Bot's membership of a Room (spec #1055): a Conversation counts as a Room when it has member
 * rows. Its rows go with the Conversation and with the Bot.
 */
export const botRoomMember = botsdkSchema.table(
  "bot_room_member",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The lead takes the user's Messages that mention no one. A Room has one. */
    lead: boolean("lead").default(false).notNull(),
    /** The Bot's reset point in the Room: it sees nothing said there before it. Null before a reset. */
    resetAt: timestamp("reset_at"),
    joinedAt: timestamp("joined_at").notNull(),
  },
  (table) => [
    primaryKey({ name: "bot_room_member_pkey", columns: [table.conversationId, table.botId] }),
    // One lead per Room.
    uniqueIndex("bot_room_member_lead_idx")
      .on(table.conversationId)
      .where(sql`${table.lead}`),
    // The Rooms a Bot is in.
    index("bot_room_member_bot_id_idx").on(table.botId),
  ],
);
