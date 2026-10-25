import {
  type AnyPgColumn,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";
import { conversation } from "../schema";
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

/**
 * What a Demonstration's event is (spec #713): a click, an input (typing, settled), a change (a
 * select, checkbox or committed field), a key (Enter, Tab, Escape or a shortcut), a navigation (a
 * page loaded in the top frame), or `pause`, the mark where the user paused, which the step list
 * shows as the gap and the cap doesn't count.
 */
export const botDemonstrationEventKind = chatSchema.enum("bot_demonstration_event_kind", [
  "click",
  "input",
  "change",
  "key",
  "navigation",
  "pause",
]);

/**
 * One step the user took while a Demonstration recorded (spec #713), captured from the Screen's
 * Chrome, with the screenshot the server took of it. A password field's value is stored masked,
 * and no screenshot is taken for it. Nothing is stored while the Demonstration is paused.
 */
export const botDemonstrationEvent = chatSchema.table(
  "bot_demonstration_event",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    demonstrationId: uuid("demonstration_id")
      .notNull()
      .references((): AnyPgColumn => botDemonstration.id, { onDelete: "cascade" }),
    /** Its place in the Demonstration, from 1. */
    sequence: integer("sequence").notNull(),
    /** Milliseconds since the Demonstration started. */
    offsetMs: integer("offset_ms").notNull(),
    kind: botDemonstrationEventKind("kind").notNull(),
    /** The page or frame it happened in; null for a pause. */
    url: text("url"),
    /** The element's aria-label, label, placeholder or text. */
    label: text("label"),
    /** A CSS selector for the element, a hint for whoever repeats the step. */
    selector: text("selector"),
    /** What was typed, chosen or pressed; `••••••••` for a password field. */
    value: text("value"),
    /** The blob key of its screenshot, or null when none was taken. */
    screenshotKey: text("screenshot_key"),
  },
  (table) => [
    uniqueIndex("bot_demonstration_event_demonstration_id_sequence_idx").on(
      table.demonstrationId,
      table.sequence,
    ),
  ],
);
