import { bigint, boolean, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/**
 * What a call on Host credentials was for. Each kind is written by the call it names: a Run, a
 * title, a web search, a transcription of a voice recording, one generated image, the embedding
 * of Knowledge text (ADR 0007, ADR 0014), a call that makes Memories (ADR 0013), a Bot's Turn, one of
 * its Helpers, the writing of a Summary, or a call that warms a Bot's cache.
 */
export const usageKind = chatSchema.enum("usage_kind", [
  "run",
  "title",
  "web_search",
  "transcription",
  "image",
  "embedding",
  "memory",
  "turn",
  "helper",
  "summary",
  "warm",
]);

/**
 * One paid call (ADR 0007), summed by a Quota: on Host credentials at its price, or a Model call on
 * the user's own key or linked plan at cost 0 (#667). It has no foreign key, so deleting a
 * Conversation keeps its usage and a Quota is never refunded; `deleteUser` removes the user's rows.
 */
export const usage = chatSchema.table(
  "usage",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    kind: usageKind("kind").notNull(),
    /** The `"provider:model"` id the call ran on. */
    model: text("model").notNull(),
    /** Every input token, cache reads and writes included. */
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** The input tokens the Provider read from its prompt cache. */
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** The input tokens the Provider wrote to its prompt cache. */
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** The Bot Turn or Helper (or, for warming, the Bot) the call was made for. */
    sourceId: text("source_id"),
    /** The hash of each section of the prompt the call sent, in order. */
    promptHashes: jsonb("prompt_hashes").$type<{ name: string; hash: string }[]>(),
    /** The cost in millionths of a US dollar. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    /** True when the cost is an estimate from characters, not from the Provider's usage. */
    estimated: boolean("estimated").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("usage_user_id_created_at_idx").on(table.userId, table.createdAt)],
);
