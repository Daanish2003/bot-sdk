import { customRuleModes, customRuleStates } from "@botsdk/client/bot/rule";
import { type AnyPgColumn, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { bot } from "./bot";

/** A Custom Rule's mode (ADR 0031): how Auto-review treats a call the rule matches. */
export const customRuleMode = botsdkSchema.enum("custom_rule_mode", customRuleModes);

/** How a Custom Rule stands: `proposed` by a Bot until the user's Approval, then `active`. */
export const customRuleState = botsdkSchema.enum("custom_rule_state", customRuleStates);

/**
 * A Custom Rule (ADR 0031): the user's standing instruction, in their own words, for one kind of
 * action. It belongs to the user, not a Bot: it applies to all their Bots.
 */
export const customRule = botsdkSchema.table(
  "custom_rule",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** The user's sentence, 1 to 500 characters. */
    text: text("text").notNull(),
    mode: customRuleMode("mode").notNull(),
    state: customRuleState("state").notNull(),
    /** The Bot that proposed it; null when the user wrote it, or once that Bot is deleted. */
    proposedByBotId: uuid("proposed_by_bot_id").references((): AnyPgColumn => bot.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("custom_rule_user_id_created_at_idx").on(table.userId, table.createdAt),
    // For the set-null of a Bot's delete.
    index("custom_rule_proposed_by_bot_id_idx").on(table.proposedByBotId),
  ],
);
