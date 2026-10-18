import { text, timestamp } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** Whether a user's Computer is running. A wake makes it `awake`; only the sleep check makes it `asleep`. */
export const computerState = chatSchema.enum("computer_state", ["asleep", "awake"]);

/**
 * A user's one Computer, shared by all their Bots: created on its first operation, and woken by
 * every operation. Its row lock covers only the lifecycle steps (a create or a resume), never the
 * commands, which run concurrently.
 */
export const computer = chatSchema.table("computer", {
  /**
   * The Host's user id, with no foreign key, as everywhere in the `chat` schema; the user's delete
   * removes the row through the plugin's `deleteUser`.
   */
  userId: text("user_id").primaryKey(),
  /** The provider's sandbox. Null until the first wake. */
  sandboxId: text("sandbox_id"),
  /** The template the sandbox was built from. Null until the first wake. */
  template: text("template"),
  state: computerState("state").notNull(),
  /** Set when each operation starts and when it finishes. */
  lastActiveAt: timestamp("last_active_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
});
