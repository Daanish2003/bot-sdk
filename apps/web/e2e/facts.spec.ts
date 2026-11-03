import { expect, test } from "@playwright/test";

import { signInAsSeededUser } from "./helpers";

test("an owner adds, edits and deletes a fact, and the log shows each change", async ({ page }) => {
  await signInAsSeededUser(page);
  await page.goto("/facts");
  await expect(page.getByText("No facts yet.")).toBeVisible();

  const add = async (key: string, type: string, topic: string, value: string) => {
    await page.getByLabel("Key", { exact: true }).fill(key);
    await page.getByLabel("Type of new fact").selectOption(type);
    await page.getByLabel("Topic of new fact").fill(topic);
    await page.getByLabel("Value of new fact").fill(value);
    await page.getByRole("button", { name: "Add fact" }).click();
    await expect(page.locator(`[data-fact="${key}"]`)).toBeVisible();
  };
  await add("price.haircut", "money", "Prices", "45 USD");
  await add("hours.week", "hours", "Hours", "Mon-Fri 09:00-17:00");
  await expect(page.locator("[data-topic]")).toHaveCount(2);

  // A value that doesn't fit its type is refused, and nothing is added.
  await page.getByLabel("Key", { exact: true }).fill("phone.main");
  await page.getByLabel("Type of new fact").selectOption("phone");
  await page.getByLabel("Topic of new fact").fill("Contact");
  await page.getByLabel("Value of new fact").fill("call us");
  await page.getByRole("button", { name: "Add fact" }).click();
  await expect(page.locator('[data-fact="phone.main"]')).toHaveCount(0);

  // Another fact with an existing key is refused.
  await page.reload();
  await add("price.beard", "money", "Prices", "20 USD");
  await page.getByLabel("Key", { exact: true }).fill("price.beard");
  await page.getByLabel("Type of new fact").selectOption("text");
  await page.getByLabel("Topic of new fact").fill("Prices");
  await page.getByLabel("Value of new fact").fill("Free");
  await page.getByRole("button", { name: "Add fact" }).click();
  await expect(page.getByText("You already have a fact with that key.")).toBeVisible();

  const row = page.locator('[data-fact="price.haircut"]');
  await row.getByLabel("Value of price.haircut").fill("50 USD");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-log="edit"]')).toContainText("was 45 USD");
  await expect(page.locator('[data-log="edit"]')).toContainText("now 50 USD");

  await page.getByRole("button", { name: "Delete price.haircut" }).click();
  await expect(page.locator('[data-fact="price.haircut"]')).toHaveCount(0);
  await expect(page.locator('[data-log="delete"]')).toContainText("price.haircut");
  await page.reload();
  await expect(page.locator('[data-fact="price.haircut"]')).toHaveCount(0);
  await expect(page.locator("[data-log]")).toHaveCount(5);
});
