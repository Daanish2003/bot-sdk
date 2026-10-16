import { storedParts } from "../../core/shared/message-parts";
import { conversation, message } from "../../core/server/db/schema/chat";
import { getTestDb } from "./test-database";
import { eq } from "drizzle-orm";

import { uuidv7 } from "../../core/server/lib/uuidv7";
import type { TestUser } from "./users";

export const testModel = "anthropic:claude-sonnet-5-5";

/** Inserts a Conversation for `user` straight into the test database. */
export async function insertConversation(
  user: TestUser,
  fields: Partial<typeof conversation.$inferInsert> = {},
) {
  const [row] = await getTestDb()
    .insert(conversation)
    .values({ id: uuidv7(), userId: user.id, model: testModel, ...fields })
    .returning();
  if (!row) throw new Error("Inserting the test Conversation returned no row");
  return row;
}

/**
 * Inserts a Message with the given text straight into the test database (a `complete` reply by
 * default for the assistant). Pass `active: true` to make it the Conversation's Active Branch leaf.
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
      parts: storedParts(text ? [{ type: "text", text }] : []),
      searchText: text,
      status: "complete",
      model: role === "assistant" ? testModel : null,
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
