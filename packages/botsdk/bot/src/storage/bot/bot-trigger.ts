import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { conversation, message } from "../schema";
import { botTurn } from "./bot-turn";

/**
 * Who sent a Trigger: the user, one of the Bot's Routines, a Check-in it set (#539), a Helper
 * (#565), or an Approval answered after its wait (ADR 0030).
 */
export const botTriggerSource = botsdkSchema.enum("bot_trigger_source", [
  "user",
  "routine",
  "check_in",
  "helper",
  "approval",
]);

/**
 * Why a Trigger was skipped (spec #1007): the user skipped it from the Tasks view (`cancelled`), it
 * came due or waited while its Bot was paused (`paused`), or its Bot was reset (`reset`).
 */
export const botTriggerSkipReason = botsdkSchema.enum("bot_trigger_skip_reason", [
  "cancelled",
  "paused",
  "reset",
]);

/**
 * One Trigger the Router received for a Conversation (#499). Untaken (`turn_id` null), it waits in
 * the Conversation queue until a Turn takes it and sets `turn_id`, or until it is skipped (spec
 * #1007). A Turn's provenance is the Triggers it took.
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
    /**
     * Where it came in: `web`, `schedule`, `webhook`, `helper`, `email` (spec #761), or the id of a
     * messaging platform such as `telegram` (spec #1044). Text, as the platforms are the Host's.
     */
    channel: text("channel").notNull(),
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
    /** When the Trigger was skipped; null unless it was. A skipped Trigger is never taken by a Turn. */
    skippedAt: timestamp("skipped_at"),
    /** Why it was skipped, set with `skippedAt`. */
    skipReason: botTriggerSkipReason("skip_reason"),
  },
  (table) => [
    // The Conversation queue: the Triggers no Turn has taken yet and none skipped.
    index("bot_trigger_waiting_idx")
      .on(table.conversationId, table.receivedAt)
      .where(sql`${table.turnId} is null and ${table.skippedAt} is null`),
    index("bot_trigger_turn_id_idx").on(table.turnId),
    // The skipped Triggers of a Conversation (spec #1007): the Tasks view's Done, and the Messages a
    // Turn leaves out.
    index("bot_trigger_skipped_idx")
      .on(table.conversationId, table.skippedAt)
      .where(sql`${table.skippedAt} is not null`),
    // A skipped Trigger has its reason, and no Turn took it.
    check(
      "bot_trigger_skipped_check",
      sql`(${table.skippedAt} is null) = (${table.skipReason} is null) and (${table.skippedAt} is null or ${table.turnId} is null)`,
    ),
  ],
);
