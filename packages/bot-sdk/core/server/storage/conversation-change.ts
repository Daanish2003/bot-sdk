import { type AnyPgColumn, integer, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "./botsdk-schema";
import { conversation } from "./schema";

/**
 * One change to what a Conversation's thread shows (ADR 0026): its `seq` is the Conversation's
 * `last_seq` at the change, bumped under the Conversation's row lock in the change's transaction,
 * so a Conversation's changes commit in seq order with no gaps. Only the newest
 * `retainedChanges` per Conversation are kept.
 */
export const conversationChange = botsdkSchema.table(
  "conversation_change",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** What changed, named by the plugin that owns the thread (the Bot's: `message`, `turn`, …). */
    kind: text("kind").notNull(),
    /** The id of what changed, as text: a uuid for most kinds, a Secret's name for `secret`. */
    refId: text("ref_id").notNull(),
    at: timestamp("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.seq] })],
);
