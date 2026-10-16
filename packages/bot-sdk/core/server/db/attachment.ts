import {
  type AnyPgColumn,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";
import { message } from "./schema";

/**
 * A file a user uploaded to attach to Messages. Immutable once uploaded; Messages reference it
 * through `message_attachment`, never copy it (ADR 0001). The bytes live in the blob store, under
 * the key `attachment/<id>`, so reading the metadata never loads them.
 */
export const attachment = chatSchema.table(
  "attachment",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key. */
    userId: text("user_id").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    /** Size in bytes. */
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("attachment_user_id_created_at_idx").on(table.userId, table.createdAt)],
);

/**
 * Which attachments a Message carries, in order. Goes with its Message; an attachment can't be
 * deleted while a Message uses it (default `NO ACTION`).
 */
export const messageAttachment = chatSchema.table(
  "message_attachment",
  {
    messageId: uuid("message_id")
      .notNull()
      .references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachment.id),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.attachmentId] }),
    index("message_attachment_attachment_id_idx").on(table.attachmentId),
  ],
);

export type AttachmentRow = typeof attachment.$inferSelect;
