import type { JSONSchema } from "@tanstack/ai";
import { type AnyPgColumn, index, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { bot } from "./bot";
import { botSummary } from "./bot-summary";

/** A tool's definition exactly as a Prompt start sends it: its name, description and JSON Schema. */
export type PromptStartTool = { name: string; description: string; inputSchema?: JSONSchema };

/** One section of a Prompt start: a system block or the first message, with the sha256 of `text`. */
export type PromptStartSection = { name: string; text: string; hash: string };

/**
 * A Bot's Prompt start (slide 31): the tools, sorted by name, the system blocks and the first
 * message, exactly as every model call sends them until the next Summary. A Turn's model calls
 * and their replays read the stored bytes, never a rebuild.
 */
export const botPromptStart = chatSchema.table(
  "bot_prompt_start",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    builtAt: timestamp("built_at").notNull(),
    /** The Summary its first message holds. Null for the Bot's first Prompt start. */
    summaryId: uuid("summary_id").references((): AnyPgColumn => botSummary.id, {
      onDelete: "cascade",
    }),
    /** The tool definitions sent, sorted by name. */
    tools: jsonb("tools").$type<PromptStartTool[]>().notNull(),
    /** The system blocks in their fixed order, then the first message. */
    sections: jsonb("sections").$type<PromptStartSection[]>().notNull(),
  },
  (table) => [index("bot_prompt_start_bot_id_built_at_idx").on(table.botId, table.builtAt.desc())],
);
