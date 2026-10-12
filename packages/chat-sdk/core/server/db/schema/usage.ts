import { bigint, boolean, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

/** What a call on Host credentials was for. Only `run` is written so far. */
export const usageKind = chatSchema.enum("usage_kind", ["run", "title", "web_search"]);

/**
 * One call on Host credentials (ADR 0007), summed by a Quota. It has no foreign key, so deleting a
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
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** The cost in millionths of a US dollar. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    /** True when the cost is an estimate from characters, not from the Provider's usage. */
    estimated: boolean("estimated").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("usage_user_id_created_at_idx").on(table.userId, table.createdAt)],
);
