import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { bot } from "./bot";
import { botTurn } from "./bot-turn";

/** When a Summary was written: while the user was away, or in the middle of a Turn (slide 34). */
export const botSummaryKind = botsdkSchema.enum("bot_summary_kind", ["away", "mid_turn"]);

/**
 * A Summary of a Bot's Conversation (slide 34): a prose account written by the Bot's model, with
 * the Bot's last 3 Messages to the user quoted word for word. Writing one builds a new Prompt start
 * whose first message holds it, and history carries on from `covers_until`.
 */
export const botSummary = botsdkSchema.table(
  "bot_summary",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The Summary as the first message holds it. */
    text: text("text").notNull(),
    /**
     * Everything before it is summarized: the Turns that started before it. A `mid_turn` Summary's
     * own Turn carries on in history from the Summary's note in its transcript.
     */
    coversUntil: timestamp("covers_until").notNull(),
    kind: botSummaryKind("kind").notNull(),
    /** The Turn a `mid_turn` Summary was written in. Null for `away`. */
    turnId: uuid("turn_id").references((): AnyPgColumn => botTurn.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("bot_summary_bot_id_created_at_idx").on(table.botId, table.createdAt.desc())],
);
