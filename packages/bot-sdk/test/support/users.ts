import { randomUUID } from "node:crypto";

import { user as userTable } from "@ai-chat/db/schema/auth";

import { getTestDb } from "./test-database";

export type TestUser = typeof userTable.$inferSelect;

/** Inserts a user row into the test database. */
export async function insertUser(fields: Partial<typeof userTable.$inferInsert> = {}) {
  const id = fields.id ?? randomUUID();
  const [row] = await getTestDb()
    .insert(userTable)
    .values({ name: "Test User", email: `${id}@example.com`, ...fields, id })
    .returning();
  if (!row) throw new Error("Inserting the test user returned no row");
  return row;
}
