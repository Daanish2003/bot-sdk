import { type AnyPgColumn, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { conversation } from "../../../../core/server/db/schema";
import { bot } from "./bot";

/**
 * How a Demonstration stands (spec #713): `recording` ⇄ `paused` while the user shows the task,
 * then `drafting` once they tap Done, and `saved` with its Skill, or `failed`. Cancel, while it
 * records or is paused, ends it `cancelled`.
 */
export const botDemonstrationState = chatSchema.enum("bot_demonstration_state", [
  "recording",
  "paused",
  "drafting",
  "saved",
  "cancelled",
  "failed",
]);

/**
 * A Demonstration (spec #713): the user doing a task once on their Bot's Screen while the Bot
 * watches, started by the Bot's `watch_user`. It holds the Screen while it records or is paused,
 * and outlives the Turn that started it. The row stays as a record once it ends.
 */
export const botDemonstration = chatSchema.table(
  "bot_demonstration",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    /** The Bot's Conversation, where its Show me card is. */
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    /** What the user shows, in the Bot's words. */
    goal: text("goal").notNull(),
    /** What changes each time the task is done. */
    inputs: text("inputs").array().notNull(),
    state: botDemonstrationState("state").notNull(),
    /** The Screen slot (1 to 4) it holds while it records or is paused. */
    screen: integer("screen").notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    /** The Skill it was saved as, once `saved`. */
    skillName: text("skill_name"),
  },
  (table) => [index("bot_demonstration_bot_id_state_idx").on(table.botId, table.state)],
);
