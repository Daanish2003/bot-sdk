import { type AnyPgColumn, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import { message } from "../../../../core/server/db/schema";

/**
 * An image the chat Model made with `generate_image` (spec #278). Each one belongs to the Message
 * whose reply made it, and goes with that Message: deleting a Conversation deletes its rows. The
 * bytes live in the blob store under `generated-image/<id>`, not in this row.
 */
export const generatedImage = chatSchema.table(
  "generated_image",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
    mediaType: text("media_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** Size in bytes. */
    size: integer("size").notNull(),
    /** The `"provider:model"` Image Model that made it. */
    model: text("model").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("generated_image_message_id_idx").on(table.messageId)],
);

export type GeneratedImageRow = typeof generatedImage.$inferSelect;
