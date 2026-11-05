import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { e2eDatabaseUrl } from "./database";
import { signInAsSeededUser } from "./helpers";
import { seedDraft } from "./support/reply-drafts";

/** A Page waiting for the owner, as a feature would have raised it. */
async function seedPage(
  userId: string,
  { urgency, title }: { urgency: "routine" | "emergency"; title: string },
) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(
      "insert into botsdk.page (id, user_id, cause, urgency, title, text, path, created_at) values ($1, $2, 'test', $3, $4, 'Look at this.', '/representatives', $5)",
      [randomUUID(), userId, urgency, title, new Date()],
    );
  } finally {
    await db.$client.end();
  }
}

test("an owner answers what needs them from one inbox, emergencies first", async ({ page }) => {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Billing desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const representativeId = page.url().split("/").pop()!;
  await seedPage(owner.id, { urgency: "routine", title: "Routine check" });
  await seedDraft(owner.id, representativeId, { name: "Ana", text: "<b>Ten</b> dollars." });
  await seedPage(owner.id, { urgency: "emergency", title: "Pipe burst" });

  await page.goto("/inbox");

  const queue = page.locator("[data-inbox-item]");
  await expect(queue).toHaveCount(3);
  await expect(queue.nth(0)).toContainText("Pipe burst");
  await expect(queue.nth(1)).toContainText("Ana");
  await expect(queue.nth(2)).toContainText("Routine check");
  await expect(page.getByText("Choose something from the list")).toBeVisible();
  await expect(
    page.locator("[data-inbox-running-thread]").filter({ hasText: "Ana" }),
  ).toBeVisible();

  // The draft opens beside the queue, and approving it takes it off.
  await queue.nth(1).click();
  const draft = page.locator("[data-reply-draft]");
  await expect(draft).toContainText("<b>Ten</b> dollars.");
  await expect(draft.locator("b")).toHaveCount(0);
  await draft.getByRole("button", { name: "Approve and send" }).click();
  await expect(draft).toHaveCount(0);
  await expect(queue).toHaveCount(2);

  await queue.nth(0).click();
  await page.getByRole("button", { name: "Acknowledge Pipe burst" }).click();
  await expect(queue).toHaveCount(1);
  await expect(queue.nth(0)).toContainText("Routine check");

  // The Representative's switch is on this view too.
  const serving = page.getByRole("checkbox", { name: "Serving: Billing desk" });
  await expect(serving).toBeChecked();
  await serving.click();
  await expect(serving).not.toBeChecked();
});
