import { bytea, text } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

/**
 * Bytes kept by the default `postgresBlobStore()` (ADR 0015), one row per key. The keys are the
 * SDK's (`bot-file/<id>`), and nothing here knows what a key is for; the owner and the metadata
 * stay in their own tables.
 */
export const blob = chatSchema.table("blob", {
  key: text("key").primaryKey(),
  bytes: bytea("bytes").notNull(),
});
