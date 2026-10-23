import { expect, type Page, test } from "@playwright/test";

import { wideMarker } from "../../../packages/bot-sdk/test/e2e/fake-ollama";

import { messageRows, send, signInAsSeededUserWithModel } from "./assistant-helpers";

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

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("link").first().click();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
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

test("the composer's text is 16px, and a wide table and long code line scroll inside the reply", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await send(page, `${wideMarker} Show me a wide table`);
  await expect(messageRows(page).last()).toContainText("Column six");

  // 16px, so iOS doesn't zoom the page when the composer takes focus.
  await expect(page.getByLabel("Message", { exact: true })).toHaveCSS("font-size", "16px");
  await expectNoSidewaysScroll(page);
});
