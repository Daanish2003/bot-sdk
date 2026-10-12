import { expect, test } from "@playwright/test";

import {
  messageRows,
  send,
  signInAsSeededUser,
  signInAsSeededUserWithModel,
  signInOnForm,
} from "./helpers";

test("the home page sends a signed-out visitor to log in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("a seeded user is signed in, and its password signs in on the form", async ({ page }) => {
  const user = await signInAsSeededUser(page);
  await page.goto("/settings/keys");
  await expect(page.getByRole("heading", { name: "Keys & settings" })).toBeVisible();

  await page.context().clearCookies();
  await signInOnForm(page, user.email, user.password);
  await expect(page).toHaveURL(/\/c$/);
});

test("the palette opens with the platform's shortcut and finds a Message", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await send(page, "Remember the word pineapple");
  await page.goto("/c");

  const shortcut = process.platform === "darwin" ? "⌘K" : "Ctrl+K";
  await expect(page.getByRole("banner").locator("kbd")).toHaveText(shortcut);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox", { name: /^Search Conversations/ }).fill("pineapple");
  const hit = palette.getByRole("group", { name: "In Messages" }).getByRole("option").first();
  await expect(hit).toContainText("pineapple");
  await hit.click();

  await expect(page).toHaveURL(/\/c\/[\w-]+/);
  await expect(messageRows(page).first()).toContainText("Remember the word pineapple");
});

test("on a wide screen the composer lines up with the Messages", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await signInAsSeededUserWithModel(page);
  await send(page, "Line me up");

  const avatarColumn = (await messageRows(page).first().locator("> div").boundingBox())!;
  const composer = (await page.getByLabel("Message", { exact: true }).boundingBox())!;
  expect(avatarColumn.width).toBeLessThanOrEqual(896);
  expect(
    Math.abs(composer.x + composer.width / 2 - (avatarColumn.x + avatarColumn.width / 2)),
  ).toBeLessThan(2);
});

test("the Conversation panel stays collapsed after a reload", async ({ page }) => {
  await signInAsSeededUser(page);
  const panel = page.getByRole("complementary", { name: "Conversations" });
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Conversations" }).click();
  await expect(panel).toBeHidden();
  await page.reload();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Show Conversations" }).click();
  await expect(panel).toBeVisible();
});
