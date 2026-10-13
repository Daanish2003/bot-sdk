import { createDb, type Database } from "@ai-chat/db";
import { user } from "@ai-chat/db/schema/auth";
import { userQuota } from "@ai-chat/db/schema/quota";
import { afterAll, describe, expect, it } from "vitest";

import { getQuota } from "./quota";

const database: Database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const window = new Date("2026-10-13T00:00:00Z");

afterAll(async () => {
  await database.$client.end();
});

/** A signed-up user, so an override row can reference it (the foreign key). */
async function insertUser(id: string) {
  await database.insert(user).values({ id, name: id, email: `${id}@example.com` });
  return id;
}

describe("getQuota", () => {
  it("returns the Admin's override budget, in the Host's window", async () => {
    const userId = await insertUser("override-budget");
    await database.insert(userQuota).values({ userId, budgetUsd: 2, updatedAt: window });

    expect(await getQuota(database, { HOST_QUOTA_WINDOW: "month" }, userId)).toEqual({
      budgetUsd: 2,
      window: "month",
    });
  });

  it("returns a 0 budget as is, which turns Host Models off for that user", async () => {
    const userId = await insertUser("zero-budget");
    await database.insert(userQuota).values({ userId, budgetUsd: 0, updatedAt: window });

    expect(await getQuota(database, { HOST_QUOTA_BUDGET_USD: "5" }, userId)).toEqual({
      budgetUsd: 0,
      window: "day",
    });
  });

  it("returns null for an override of null, which is unlimited even when the Host sets a Quota", async () => {
    const userId = await insertUser("unlimited");
    await database.insert(userQuota).values({ userId, budgetUsd: null, updatedAt: window });

    expect(await getQuota(database, { HOST_QUOTA_BUDGET_USD: "5" }, userId)).toBeNull();
  });

  it("falls back to the Host's default Quota with no row", async () => {
    const userId = await insertUser("no-row");

    expect(
      await getQuota(
        database,
        { HOST_QUOTA_BUDGET_USD: "0.5", HOST_QUOTA_WINDOW: "month" },
        userId,
      ),
    ).toEqual({ budgetUsd: 0.5, window: "month" });
  });

  it("is unlimited with no row and no Host default", async () => {
    const userId = await insertUser("no-default");

    expect(await getQuota(database, {}, userId)).toBeNull();
  });
});
