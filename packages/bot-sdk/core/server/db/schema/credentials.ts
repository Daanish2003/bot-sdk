import { boolean, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

/**
 * A user's Provider credentials or Tool credential for one service (ADR 0003).
 * `encrypted` is the AES-256-GCM encrypted JSON of the service's fields; the client only sees `hint`.
 */
export const userCredentials = chatSchema.table(
  "user_credentials",
  {
    /** The Host's user id, with no foreign key. */
    userId: text("user_id").notNull(),
    /** A Provider id (`"anthropic"`, …) or a tool service (`"tavily"`). */
    service: text("service").notNull(),
    encrypted: text("encrypted").notNull(),
    hint: text("hint").notNull(),
    /** False when the service has no check endpoint and the credentials were saved unchecked. */
    verified: boolean("verified").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.service] })],
);
