import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** A Project: a named group of one user's Conversations, with Instructions and a default Model. */
export const project = chatSchema.table(
  "project",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id. Like a Conversation's, it has no foreign key to the user. */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    /** The Project's Instructions; null when it has none. */
    instructions: text("instructions"),
    /** The default Model, `"provider:model"`; null when it has none. */
    defaultModel: text("default_model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("project_user_id_idx").on(table.userId)],
);
