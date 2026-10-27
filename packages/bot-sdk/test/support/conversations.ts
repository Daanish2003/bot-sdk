import { conversation, message } from "@botsdk/bot/storage";
import { getTestDb } from "./test-database";
import { eq } from "drizzle-orm";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { TestUser } from "./users";

/** Inserts a Conversation for `user` straight into the test database: a Bot one by default. */
export async function insertConversation(
  user: TestUser,
  { kind = "bot", ...fields }: Partial<typeof conversation.$inferInsert> = {},
) {
  const [row] = await getTestDb()
    .insert(conversation)
    .values({ id: uuidv7(), userId: user.id, kind, ...fields })
    .returning();
  if (!row) throw new Error("Inserting the test Conversation returned no row");
  return row;
}

/**
 * Inserts a Message with the given text straight into the test database (`complete` by default).
 * Pass `active: true` to make it the Conversation's Active Branch leaf.
 */
export async function insertMessage({
  conversationId,
  parentId = null,
  role,
  text,
  active = false,
  ...fields
}: {
  conversationId: string;
  parentId?: string | null;
  role: "user" | "assistant";
  text: string;
  active?: boolean;
} & Partial<typeof message.$inferInsert>) {
  const db = getTestDb();
  const [row] = await db
    .insert(message)
    .values({
      id: uuidv7(),
      conversationId,
      parentId,
      role,
      parts: { schemaVersion: 5, parts: text ? [{ type: "text", text }] : [] },
      status: "complete",
      // The host clock, like the Run endpoint: the database clock can sit ahead of it, and Messages sort by this.
      createdAt: new Date(),
      ...fields,
    })
    .returning();
  if (!row) throw new Error("Inserting the test Message returned no row");
  if (active) {
    await db
      .update(conversation)
      .set({ activeLeafId: row.id })
      .where(eq(conversation.id, conversationId));
  }
  return row;
}
