import { primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { chatSchema } from "../chat-schema";

/**
 * A Secret (spec #691): a value such as a password or token that the user typed into a Secret card,
 * stored encrypted under the keyring with a key of its own kind (ADR 0010). It belongs to the user,
 * not a Bot: all their Bots can use it. The model only ever sees its name.
 */
export const botSecret = chatSchema.table(
  "secret",
  {
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    /** An environment-variable-style name, such as `GITHUB_TOKEN`, unique per user. */
    name: text("name").notNull(),
    /** The value as `v2.<kid>.<iv>.<tag>.<ciphertext>`; never the plaintext. */
    encrypted: text("encrypted").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })],
);
