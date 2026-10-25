import { index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";

/**
 * A file the user uploaded to send their Bot (spec #801), until a Message sends it. Its bytes sit
 * in the blob store under `bot-file/<id>` (ADR 0015). The send deletes the row: the Message's
 * `files` part holds the file from then on. A row no send took is an orphan, deleted with its bytes
 * after 24 hours.
 */
export const botUpload = chatSchema.table(
  "bot_upload",
  {
    /** uuidv7, generated in app code; also the file's id in the `files` part. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  // Every upload sweeps the orphans by age, and a user's delete takes theirs.
  (table) => [
    index("bot_upload_created_at_idx").on(table.createdAt),
    index("bot_upload_user_id_idx").on(table.userId),
  ],
);
