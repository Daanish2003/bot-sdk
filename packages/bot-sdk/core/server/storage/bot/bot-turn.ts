import type { ModelMessage } from "@tanstack/ai";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";
import { job } from "../runner/job";
import type { BotMemoryChange } from "../../../../plugins/memory/shared/changes";
import type { BotKnowledgeChange } from "../../../../plugins/knowledge/shared/changes";
import type { BotSkillChange } from "../../../../plugins/skills/shared/changes";
import type { MessageUsage } from "../../../../plugins/models/shared/usage";
import { bot } from "./bot";
import { botPromptStart } from "./bot-prompt-start";

/** How a Turn stands: `running` until it ends `complete`, `error` or `stopped`. */
export const botTurnStatus = chatSchema.enum("bot_turn_status", [
  "running",
  "complete",
  "error",
  "stopped",
]);

/**
 * One Turn of a Bot: what a user Message started, run as one runner job (ADR 0011, the #482
 * amendment). Its `transcript` is the Model's private side of the Turn (its plain text, its
 * SendToUser calls and their results). It is written once when the Turn ends, is replayed as the
 * input of later Turns, and is never a Message.
 */
export const botTurn = chatSchema.table(
  "bot_turn",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    status: botTurnStatus("status").notNull(),
    /** Why an `error` Turn failed. */
    error: text("error"),
    usage: jsonb("usage").$type<MessageUsage>(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    /**
     * The job that runs the Turn, and its liveness. Null once the job is pruned, and for Turns from
     * before Turns ran as jobs.
     */
    jobId: uuid("job_id").references((): AnyPgColumn => job.id, { onDelete: "set null" }),
    /**
     * The newest message the Turn sent, exactly as sent: what arrived since the last Turn that sent
     * one, the newest opening with its time and to-do notes. Later Turns replay it, then the
     * `transcript`, so history only grows at the end. Null until the Turn saves it before its first
     * model call, and for a Turn that never got that far.
     */
    input: jsonb("input").$type<ModelMessage[]>(),
    /**
     * The Prompt start the Turn's model calls send, set before its first one: the Bot's latest, or
     * the one its first Turn builds. After a mid-Turn Summary, its later calls send the Summary's.
     */
    promptStartId: uuid("prompt_start_id").references((): AnyPgColumn => botPromptStart.id, {
      onDelete: "set null",
    }),
    /** The Turn's model messages, after its input. Null until the Turn ends. */
    transcript: jsonb("transcript").$type<ModelMessage[]>(),
    /**
     * What the Turn's post-turn memory pass changed (ADR 0022), for its "Memory updated" chip.
     * Null until a pass changes something, and with no `memory` plugin.
     */
    memoryChanges: jsonb("memory_changes").$type<BotMemoryChange[]>(),
    /**
     * The Skills the Turn's `write` and `edit` calls saved or updated (spec #713), for its Skill
     * chip. Null when it wrote none.
     */
    skillChanges: jsonb("skill_changes").$type<BotSkillChange[]>(),
    /**
     * The files the Turn's `write` and `edit` calls saved under `shared/knowledge/` (spec #737),
     * for its "saved to Knowledge" chip. Null when it saved none.
     */
    knowledgeChanges: jsonb("knowledge_changes").$type<BotKnowledgeChange[]>(),
  },
  (table) => [
    index("bot_turn_bot_id_started_at_idx").on(table.botId, table.startedAt.desc()),
    // One running Turn per Bot (#499): it backs up the Conversation's row lock, so a missed lock is
    // an error instead of a second running Turn. A Bot has exactly one Conversation.
    uniqueIndex("bot_turn_running_bot_id_idx")
      .on(table.botId)
      .where(sql`${table.status} = 'running'`),
  ],
);
