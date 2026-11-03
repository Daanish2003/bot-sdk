import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { user } from "@ai-chat/db/schema/auth";
import { closeTestDb, getTestDb, truncateAllTables } from "../src/test-database";

describe("emptying the tables while an earlier test's work still runs", () => {
  // A job a stopped runner gave up on: its transaction reads a table, then waits on a read on another
  // connection. That read queues behind the truncate, which waits for the transaction, and Postgres
  // sees no deadlock, as the transaction only sits idle.
  it("lets the work finish, rather than wait on it forever", async () => {
    const db = getTestDb();
    await truncateAllTables(db);
    let truncate: Promise<void> | undefined;

    await db.transaction(async (tx) => {
      await tx.select().from(user);
      truncate = truncateAllTables(db);
      // Long enough for the truncate to be queued on its lock before this read.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await db.select().from(user);
    });

    await expect(truncate).resolves.toBeUndefined();
    await expect(db.execute(sql`select 1`)).resolves.toBeTruthy();
  }, 8_000);

  it("gives the next file a new pool while the old one waits to close", async () => {
    const closing = getTestDb();
    const held = await closing.$client.connect();

    const closed = closeTestDb();

    const next = getTestDb();
    expect(next).not.toBe(closing);
    await expect(next.execute(sql`select 1`)).resolves.toBeTruthy();
    held.release();
    await closed;
  });
});

// The two tests insert the same unique email: the second only passes if the
// tables were truncated after the first.
describe("test database", () => {
  for (const attempt of ["first", "second"]) {
    it(`starts each test with empty tables (${attempt})`, async () => {
      const db = getTestDb();

      await expect(db.$count(user)).resolves.toBe(0);
      await db.insert(user).values({ id: attempt, name: "Grace", email: "grace@example.com" });
      await expect(db.$count(user)).resolves.toBe(1);
    });
  }
});
