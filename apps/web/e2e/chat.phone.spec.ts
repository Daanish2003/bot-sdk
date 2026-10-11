import { expect, type Page, test } from "@playwright/test";

import { messageRows, send, signInAsSeededUser, signInAsSeededUserWithModel } from "./helpers";

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the Conversation panel is a drawer, closed until the menu opens it", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await send(page, "A phone Conversation");
  const panel = page.getByRole("complementary", { name: "Conversations" });
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("link").first().click();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "New Conversation" }).click();
  await expect(page).toHaveURL(/\/c$/);
  await expect(panel).toBeHidden();
});

test("a Conversation fits the screen, with its title and Message actions showing", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await send(page, "Does this fit on a phone?");

  await expect(page.getByRole("banner").getByTitle("Rename")).toBeVisible();
  const titleBox = (await page.getByRole("banner").getByTitle("Rename").boundingBox())!;
  expect(titleBox.width).toBeGreaterThan(40);

  // No hover on a touch screen: Copy, Edit and Regenerate show without it.
  await expect(messageRows(page).first().getByRole("button", { name: "Edit" })).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(messageRows(page).last().getByRole("button", { name: "Regenerate" })).toHaveCSS(
    "opacity",
    "1",
  );
  await expectNoSidewaysScroll(page);
});

test("the login, Keys, Account and new Conversation pages fit the screen", async ({ page }) => {
  await page.goto("/login");
  await expectNoSidewaysScroll(page);
  await signInAsSeededUser(page);
  await expectNoSidewaysScroll(page);
  await page.goto("/settings/keys");
  await expect(page.getByRole("heading", { name: "Keys & settings" })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.goto("/settings/account");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
});
