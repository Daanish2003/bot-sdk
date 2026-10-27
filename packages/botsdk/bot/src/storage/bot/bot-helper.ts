import type { ModelMessage } from "@tanstack/ai";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";
import { job } from "../runner/job";
import type { MessageUsage } from "../../models/shared/usage";
import { bot } from "./bot";
import { botTurn } from "./bot-turn";

/** What a Helper works with: the Shell and Files, or a Screen's browser and desktop (#565). */
export const botHelperType = botsdkSchema.enum("bot_helper_type", ["general", "computer_use"]);

/**
 * How a Helper stands: `running`, `waiting` for the user at a hand-off (Computer-use only), then it
 * ends `complete`, `error` or `stopped`.
 */
export const botHelperStatus = botsdkSchema.enum("bot_helper_status", [
  "running",
  "waiting",
  "complete",
  "error",
  "stopped",
]);

/**
 * A Helper (#565): one complete task a Bot handed off, run as its own `bot.helper` job with its own
 * fresh context. It outlives the Turn that started it, and its finish reaches the Bot as a `helper`
 * Trigger. Shaped like `bot_turn`.
 */
export const botHelper = botsdkSchema.table(
  "bot_helper",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    type: botHelperType("type").notNull(),
    /** The complete task description, the only thing the Helper is told. */
    task: text("task").notNull(),
    status: botHelperStatus("status").notNull(),
    /** Its final plain text, capped at 2,000 characters; null until it ends. */
    report: text("report"),
    /** The Turn whose `start_helper` call started it. */
    startedByTurnId: uuid("started_by_turn_id")
      .notNull()
      .references((): AnyPgColumn => botTurn.id, { onDelete: "cascade" }),
    /** The job that runs it. Null once the job is pruned. */
    jobId: uuid("job_id").references((): AnyPgColumn => job.id, { onDelete: "set null" }),
    /** Its own context, from the task on: it has no Conversation. Null until it ends or waits. */
    transcript: jsonb("transcript").$type<ModelMessage[]>(),
    usage: jsonb("usage").$type<MessageUsage>(),
    /** The Screen slot (1 to 4) a Computer-use Helper holds while it runs or waits. */
    screen: integer("screen"),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => [index("bot_helper_bot_id_status_idx").on(table.botId, table.status)],
);

/**
 * A Message from the Bot to one of its Helpers (#566), from `message_helper`. The Helper reads the
 * undelivered ones before its next model call, in an `inbox` activity that sets `deliveredAt`.
 */
export const botHelperMessage = botsdkSchema.table(
  "bot_helper_message",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    helperId: uuid("helper_id")
      .notNull()
      .references((): AnyPgColumn => botHelper.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** When the Helper's inbox read it; null until then. */
    deliveredAt: timestamp("delivered_at"),
  },
  (table) => [index("bot_helper_message_helper_id_idx").on(table.helperId, table.createdAt)],
);

/**
 * A screenshot a Computer-use Helper's computer tool took (#608). Its PNG is in the blob store under
 * `screenshot/<id>`, stored once; the Helper's transcript and its `computer` Checkpoints hold only
 * the id. The row goes with its Helper, so a delete reads the keys first (ADR 0015).
 */
export const botHelperScreenshot = botsdkSchema.table(
  "bot_helper_screenshot",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    helperId: uuid("helper_id")
      .notNull()
      .references((): AnyPgColumn => botHelper.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("bot_helper_screenshot_helper_id_idx").on(table.helperId)],
);
