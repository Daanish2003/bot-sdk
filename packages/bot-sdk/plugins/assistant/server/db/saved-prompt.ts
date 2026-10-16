import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/**
 * A Saved prompt: text a user keeps under a short name and inserts into the composer with `/name`
 * (CONTEXT.md). Names are unique per user; a Saved prompt is never sent by itself.
 */
export const savedPrompt = chatSchema.table(
  "saved_prompt",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id. Like a Conversation's, it has no foreign key to the user. */
    userId: text("user_id").notNull(),
    /** Lowercase letters, digits and `-`, up to 32 characters. */
    name: text("name").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [unique("saved_prompt_user_id_name_key").on(table.userId, table.name)],
);
