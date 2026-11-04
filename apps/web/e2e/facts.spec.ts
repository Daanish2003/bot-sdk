import { expect, test } from "@playwright/test";

import { createBot, sendToBot, signInAsSeededUser, signInAsSeededUserWithModel } from "./helpers";
import { proposedFactValue, proposedFactWhy, proposeFactMarker } from "./support/fake-ollama";

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

test("a Bot's proposal reaches the owner as a link, and is answered on the Facts page", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Ada");
  // By the app's own links, so what the Facts page read stays cached when the card links back to it.
  await page.getByRole("button", { name: "E2E User" }).click();
  await page.getByRole("menuitem", { name: "Facts" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByLabel("Key", { exact: true }).fill("price.haircut");
  await page.getByLabel("Type of new fact").selectOption("money");
  await page.getByLabel("Topic of new fact").fill("Prices");
  await page.getByLabel("Value of new fact").fill("45 USD");
  await page.getByRole("button", { name: "Add fact" }).click();
  await expect(page.locator('[data-fact="price.haircut"]')).toBeVisible();

  await page.goBack();
  await sendToBot(page, `${proposeFactMarker} Raise the haircut price`);
  const card = page.locator("[data-fact-approval]");
  await expect(card).toHaveAttribute("data-state", "waiting");
  await expect(card).toContainText(proposedFactWhy);
  await expect(card.getByRole("button")).toHaveCount(0);

  await card.getByRole("link").click();
  await expect(page).toHaveURL(/\/facts$/);
  const proposal = page.locator('[data-fact-proposal="price.haircut"]');
  await expect(proposal).toContainText(proposedFactWhy);
  await expect(proposal.locator('[data-side="current"]')).toContainText("45 USD");
  await expect(proposal.locator('[data-side="proposed"]')).toContainText(proposedFactValue);
  await expect(page.getByLabel("Value of price.haircut")).toHaveValue("45 USD");

  await page.getByRole("button", { name: "Approve price.haircut" }).click();
  await expect(proposal).toBeHidden();
  await expect(page.getByLabel("Value of price.haircut")).toHaveValue(proposedFactValue);
  await expect(page.getByText("proposed by Ada, approved by you")).toBeVisible();

  // Back by the app's history, where the thread read before the answer is cached.
  await page.goBack();
  await expect(page.locator("[data-fact-approval]")).toHaveAttribute("data-state", "approved");
});
