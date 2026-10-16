import { describe, expect, it } from "vitest";

import { user } from "@ai-chat/db/schema/auth";
import { getTestDb } from "./test-database";

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
