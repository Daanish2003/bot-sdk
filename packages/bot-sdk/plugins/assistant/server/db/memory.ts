import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { index, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { conversation } from "../../../../core/server/db/schema";

/** How a Memory was made: extracted from what the user said, or a thing they asked to remember (ADR 0013). */
export const memoryOrigin = chatSchema.enum("memory_origin", ["extracted", "said"]);

/**
 * One fact the assistant knows about a user (ADR 0013). Its scope is its Conversation's current
 * Project, through a join, so there is no `project_id`. A Memory is never deleted when a newer one
 * replaces it: it is marked invalid, and `replaced_by_id` links to the newer one.
 */
export const memory = chatSchema.table(
  "memory",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    /** Sized to the embedding Models' shared dimensions (ADR 0014). */
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    /** The `"provider:model"` embedding Model that made `embedding`. */
    embeddingModel: text("embedding_model").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    /** The user Message the fact came from. */
    sourceMessageId: uuid("source_message_id").notNull(),
    origin: memoryOrigin("origin").notNull(),
    /** Null while the Memory is valid. */
    invalidAt: timestamp("invalid_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id").references((): AnyPgColumn => memory.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memory_embedding_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("memory_conversation_id_idx").on(table.conversationId),
  ],
);

export type MemoryRow = typeof memory.$inferSelect;
