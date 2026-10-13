import { memory } from "../../core/server/db/schema/memory";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { getTestDb } from "./test-database";
import type { TestUser } from "./users";

/** Inserts a Memory straight into the test database, with a zero embedding (ADR 0013). */
export async function insertMemory(
  user: TestUser,
  fields: Partial<typeof memory.$inferInsert> & Pick<typeof memory.$inferInsert, "conversationId">,
) {
  const [row] = await getTestDb()
    .insert(memory)
    .values({
      id: uuidv7(),
      userId: user.id,
      text: "A fact about the user",
      embedding: Array.from({ length: 1536 }, () => 0),
      embeddingModel: "openai:text-embedding-3-small",
      sourceMessageId: uuidv7(),
      origin: "extracted",
      ...fields,
    })
    .returning();
  if (!row) throw new Error("Inserting the test Memory returned no row");
  return row;
}
