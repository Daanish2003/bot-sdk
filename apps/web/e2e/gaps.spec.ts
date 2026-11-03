import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { e2eDatabaseUrl } from "./database";
import { signInAsSeededUser } from "./helpers";

/** Writes an open Gap of `userId`'s into the e2e database, as a Representative's reply would log it. */
async function seedGap(userId: string, question: string, count: number, minute: number) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(
      "insert into botsdk.representative_gap (id, user_id, question, normalized, count, first_at, last_at) values ($1, $2, $3, $4, $5, $6, $6)",
      [
        randomUUID(),
        userId,
        question,
        question
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
        count,
        new Date(Date.UTC(2026, 5, 1, 9, minute)),
      ],
    );
  } finally {
    await db.$client.end();
  }
}

test("an owner turns a Gap into a fact, and dismisses another", async ({ page }) => {
  const owner = await signInAsSeededUser(page);
  await seedGap(owner.id, "Do you do weddings?", 3, 1);
  // Markup in a question shows as the text it is.
  await seedGap(owner.id, "<b>Parking</b> nearby?", 1, 2);
  await page.goto("/facts");

  await expect(page.locator("[data-gap]")).toHaveCount(2);
  const weddings = page.locator("[data-gap]", { hasText: "Do you do weddings?" });
  await expect(weddings).toContainText("Asked 3 times");
  const parking = page.locator("[data-gap]", { hasText: "Parking" });
  await expect(parking.locator("[data-gap-question]")).toHaveText("<b>Parking</b> nearby?");
  await expect(parking.locator("b")).toHaveCount(0);

  await weddings.getByLabel("Key for: Do you do weddings?").fill("services.weddings");
  await weddings.getByLabel("Value of new fact from a gap").fill("Yes, from 900 USD.");
  await weddings.getByRole("button", { name: "Turn into a fact" }).click();
  await expect(page.locator('[data-fact="services.weddings"]')).toBeVisible();
  await expect(page.locator("[data-gap]")).toHaveCount(1);
  await expect(page.locator('[data-log="add"]')).toContainText("services.weddings");

  await page.getByRole("button", { name: "Dismiss: <b>Parking</b> nearby?" }).click();
  await expect(page.locator("[data-gap]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-gap]")).toHaveCount(0);
  await expect(page.locator('[data-fact="services.weddings"]')).toBeVisible();
});
