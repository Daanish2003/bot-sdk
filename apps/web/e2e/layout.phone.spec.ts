import { expect, type Page, test } from "@playwright/test";

import { botReply, sendMarker } from "../../../packages/bot-sdk/test/e2e/fake-ollama";

import {
  botMessages,
  createBot,
  sendToBot,
  signInAsSeededUser,
  signInAsSeededUserWithModel,
} from "./helpers";

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the login, Bots, Keys and Account pages fit the screen", async ({ page }) => {
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

test("a Bot's conversation fits the screen, and its composer's text is 16px", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Phone Bot");
  await sendToBot(page, `${sendMarker} Does this fit on a phone?`);
  await expect(botMessages(page).last()).toHaveText(botReply);

  // 16px, so iOS doesn't zoom the page when the composer takes focus.
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCSS("font-size", "16px");
  await expectNoSidewaysScroll(page);
});
