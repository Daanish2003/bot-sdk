import { type AnyPgColumn, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { bot } from "./bot";
import { botHelper } from "./bot-helper";
import { botTurn } from "./bot-turn";

/** What Auto-review made of a call: it runs (`pass`), or it doesn't without the user's yes (`block`). */
export const botReviewVerdict = chatSchema.enum("bot_review_verdict", ["pass", "block"]);

/**
 * Where a blocked call's Approval stands (ADR 0024): `waiting` for the user until its deadline,
 * then `allowed` or `denied` by the user, or `expired` with no answer in time.
 */
export const botReviewState = chatSchema.enum("bot_review_state", [
  "waiting",
  "allowed",
  "denied",
  "expired",
]);

/**
 * One Auto-review of a Bot's risky tool call (spec #691): the reviewer's verdict on the call and,
 * for a block, its Approval. A call and its Approval are one row. It belongs to the Turn whose
 * call it reviewed, or to the Helper's.
 */
export const botReview = chatSchema.table(
  "bot_review",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The Turn whose call this is; null for a Helper's. */
    turnId: uuid("turn_id").references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    /** The Helper whose call this is; null for a Turn's. */
    helperId: uuid("helper_id").references((): AnyPgColumn => botHelper.id, {
      onDelete: "cascade",
    }),
    toolCallId: text("tool_call_id").notNull(),
    tool: text("tool").notNull(),
    /** The call's arguments, as the Model gave them: what a block card shows as the raw command. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    /** The call in plain words, from the reviewer. */
    summary: text("summary").notNull(),
    verdict: botReviewVerdict("verdict").notNull(),
    /** Why it passed or was blocked, from the reviewer: a block shows it to the user. */
    reason: text("reason").notNull(),
    /** A block's Approval; null for a pass, and for a block that asked for none. */
    state: botReviewState("state"),
    /** When a waiting Approval expires. */
    deadline: timestamp("deadline"),
    /** When the user allowed or denied it, or it expired. */
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("bot_review_bot_id_created_at_idx").on(table.botId, table.createdAt)],
);
