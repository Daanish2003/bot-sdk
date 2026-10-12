import { createDb } from "@ai-chat/db";
import { expect, type Page, test } from "@playwright/test";

import { usage } from "../../../packages/chat-sdk/core/server/db/schema/usage";
import { uuidv7 } from "../../../packages/chat-sdk/core/server/lib/uuidv7";

import { e2eDatabaseUrl } from "./database";
import { type SeededUser, seedUser } from "./seed-user";

/** Makes a signed-in user an Admin, straight in the e2e database (the grant script's effect). */
async function makeAdmin(seeded: SeededUser) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(`update "user" set role = 'admin' where id = $1`, [seeded.id]);
  } finally {
    await db.$client.end();
  }
}

/** Spends `costMicros` on the Host today, so the user's window reads that spend. */
async function spend(userId: string, costMicros: number) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.insert(usage).values({
      id: uuidv7(),
      userId,
      kind: "run",
      model: "e2e-model",
      inputTokens: 0,
      outputTokens: 0,
      costMicros,
      estimated: false,
      createdAt: new Date(),
    });
  } finally {
    await db.$client.end();
  }
}

const emailCell = (page: Page, email: string) =>
  page.getByRole("cell", { name: email, exact: true });

test("a user who isn't an Admin gets a 404 on /admin", async ({ page }) => {
  await seedUser(page);

  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Users", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("an Admin sees spend against Quota, searches, sorts and filters to At Quota", async ({
  page,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const atQuota = await seedUser(page);
  await spend(atQuota.id, 1_000_000);
  const quiet = await seedUser(page);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  const atQuotaRow = page.getByRole("row").filter({ has: emailCell(page, atQuota.email) });
  await expect(atQuotaRow).toContainText("$1.00 of $1.00");
  await expect(atQuotaRow).toContainText("At Quota");

  await page.getByLabel("Search by email").fill(quiet.email);
  await expect(emailCell(page, quiet.email)).toBeVisible();
  await expect(emailCell(page, atQuota.email)).toHaveCount(0);

  await page.getByLabel("Search by email").fill("");
  await page.getByRole("button", { name: "Sort by spend" }).click();
  await expect(page).toHaveURL(/sort=spend/);
  await expect(emailCell(page, atQuota.email)).toBeVisible();

  await page.getByRole("button", { name: "At Quota" }).click();
  await expect(page).toHaveURL(/atQuota=1/);
  await expect(emailCell(page, atQuota.email)).toBeVisible();
  await expect(emailCell(page, quiet.email)).toHaveCount(0);
});
