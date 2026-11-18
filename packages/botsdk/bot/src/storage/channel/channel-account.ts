import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { bot } from "../schema";

/** Whether a Channel account's listener runs, or the platform rejected its credentials (spec #1044). */
export const channelAccountStatus = botsdkSchema.enum("channel_account_status", [
  "active",
  "needs_attention",
]);

/**
 * A Channel account (spec #1044, ADR 0033): the platform bot one Bot is on a messaging Channel,
 * made by the user on that platform and added with its credentials. One per Bot and platform, and
 * one platform bot is on one Bot only. Deleting the Bot deletes it.
 */
export const channelAccount = botsdkSchema.table(
  "channel_account",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The messaging adapter's id, such as `telegram`. */
    platform: text("platform").notNull(),
    /** The platform's id of the platform bot (Telegram's bot user id). */
    platformBotId: text("platform_bot_id").notNull(),
    /** The platform bot's display handle, such as `@ada_bot`. */
    handle: text("handle").notNull(),
    /** The credentials as `v2.<kid>.<iv>.<tag>.<ciphertext>` (ADR 0010); never the plaintext. */
    encrypted: text("encrypted").notNull(),
    status: channelAccountStatus("status").notNull(),
    /** Why the platform rejected the credentials; set only while the status is `needs_attention`. */
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull(),
    /** When the credentials were last saved. */
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    unique("channel_account_bot_platform_unique").on(table.botId, table.platform),
    unique("channel_account_platform_bot_unique").on(table.platform, table.platformBotId),
    check(
      "channel_account_reason_check",
      sql`(${table.status} = 'needs_attention') = (${table.reason} is not null)`,
    ),
  ],
);
