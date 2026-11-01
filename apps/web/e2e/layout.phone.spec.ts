import { expect, type Page, test } from "@playwright/test";

import { botReply, sendMarker } from "./support/fake-ollama";

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

/**
 * The app scrolls inside `<main>`, not the document, so the document alone can't see a squashed
 * or overflowing screen. One screen at a time (spec #1117): `<main>` fills the width, the sidebar
 * is gone, nothing inside `<main>` sticks out sideways except inside a code block or table, and
 * every header button is on screen.
 */
async function expectScreenFillsPhone(page: Page) {
  await expectNoSidewaysScroll(page);
  const width = page.viewportSize()!.width;
  const main = page.locator("main").first();
  const box = (await main.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(width - 1);
  await expect(page.getByRole("complementary", { name: "Bots" })).toBeHidden();
  const stickingOut = await main.evaluate((element) => {
    const right = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")]
      .filter(
        (each) => !each.closest("pre, table") && each.getBoundingClientRect().right > right + 1,
      )
      .map((each) => each.tagName + "." + String(each.getAttribute("class")).slice(0, 40));
  });
  expect(stickingOut).toEqual([]);
  expect(
    await main.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(0);
  for (const button of await page.locator("main header").getByRole("button").all()) {
    const rect = (await button.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
  }
}

async function backToList(page: Page) {
  await page.getByRole("link", { name: "Back to Bots" }).click();
  await expect(page).toHaveURL(/\/bots$/);
  await expect(page.getByRole("complementary", { name: "Bots" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Bot" })).toBeVisible();
}

test("the login, Bots, Keys and Account pages fit the screen", async ({ page }) => {
  await page.goto("/login");
  await expectNoSidewaysScroll(page);
  await signInAsSeededUser(page);
  await expect(page.getByRole("button", { name: "New Bot" })).toBeVisible();
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

test("one screen at a time: the list at /bots, a Bot, a Room and Settings fill the phone", async ({
  page,
}) => {
  const seeded = await signInAsSeededUserWithModel(page);

  // The list screen: the sidebar fills the width, with the account menu at its foot.
  const list = page.getByRole("complementary", { name: "Bots" });
  await expect(list).toBeVisible();
  expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
  await expect(list.getByRole("button", { name: seeded.name })).toBeVisible();

  await createBot(page, "Phone One");
  await createBot(page, "Phone Two");
  await sendToBot(page, `${sendMarker} Does this fill the phone?`);
  await expect(botMessages(page).last()).toHaveText(botReply);
  await expectScreenFillsPhone(page);
  const thread = page.locator("[data-bot-thread]");
  expect((await thread.boundingBox())!.width).toBeGreaterThanOrEqual(
    page.viewportSize()!.width - 1,
  );
  await backToList(page);

  // A Room: made from the list screen.
  await page.getByRole("button", { name: "New Room" }).click();
  await page.getByRole("textbox", { name: "Room name" }).fill("Phone Room");
  await page.getByRole("button", { name: "Phone One" }).click();
  await page.getByRole("button", { name: "Phone Two" }).click();
  await page.getByRole("button", { name: "Create Room" }).click();
  await expect(page).toHaveURL(/\/bots\/rooms\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Phone Room" })).toBeVisible();
  await expectScreenFillsPhone(page);
  await backToList(page);

  // Settings, reached from the account menu on the list screen.
  await page.getByRole("button", { name: seeded.name }).click();
  await page.getByRole("menuitem", { name: "Keys" }).click();
  await expect(page.getByRole("heading", { name: "Keys & settings" })).toBeVisible();
  await expectScreenFillsPhone(page);
  await backToList(page);

  // A thread opened directly still reaches the list.
  await page.getByRole("link", { name: /Phone One/ }).click();
  const url = page.url();
  await page.goto("about:blank");
  await page.goto(url);
  await expectScreenFillsPhone(page);
  await backToList(page);
});
