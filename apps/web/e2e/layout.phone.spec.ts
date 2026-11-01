import { expect, type Locator, type Page, test } from "@playwright/test";

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
  // One way back, and in a Bot's or Room's header, the one row it shares with the title (#1129).
  await expect(page.getByRole("link", { name: "Back to Bots" })).toHaveCount(1);
  const header = page.locator("main header");
  if (await header.count()) {
    await expect(header.getByRole("link", { name: "Back to Bots" })).toBeVisible();
    const centre = async (each: Locator) => {
      const rect = (await each.boundingBox())!;
      return rect.y + rect.height / 2;
    };
    const arrow = await centre(header.getByRole("link", { name: "Back to Bots" }));
    for (const button of await header.getByRole("button").all()) {
      expect(Math.abs((await centre(button)) - arrow)).toBeLessThanOrEqual(4);
    }
  }
}

async function expectWithinScreen(page: Page, locator: Locator) {
  const rect = (await locator.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(height);
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

// 360 px wide, the narrowest common phone: a 24rem popover is wider than the screen.
test.describe("narrow phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test("a Bot's header holds the back arrow, avatar and name, and the rest is in the menu", async ({
    page,
  }) => {
    await signInAsSeededUserWithModel(page);
    await createBot(page, "Phone Header Bot");
    await sendToBot(page, `${sendMarker} Is the header tidy?`);
    await expect(botMessages(page).last()).toHaveText(botReply);

    const header = page.locator("main header");
    await expect(header.getByRole("heading", { name: "Phone Header Bot" })).toBeVisible();
    // Nothing is waiting, so Waiting is not there; the rest of the buttons are in the menu.
    await expect(header.getByRole("button", { name: /^Waiting/ })).toBeHidden();
    await expect(header.getByRole("button", { name: /^(Tasks|Email|Channels)/ })).toHaveCount(0);
    await expectScreenFillsPhone(page);

    // By keyboard: the menu is named, opens on Enter, and its items are reached by the arrows.
    const menuButton = header.getByRole("button", { name: "Bot menu" });
    await menuButton.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Bot menu" });
    await expect(menu).toBeVisible();
    await expectWithinScreen(page, menu);
    for (const name of [/^Tasks/, /^Email/, /^Channels/, /^Pause/, /^Reset/]) {
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: /^Tasks/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /^Email/ })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: /^Tasks/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    const tasks = page.getByRole("tablist", { name: "Tasks" });
    await expect(tasks).toBeVisible();
    await expectWithinScreen(
      page,
      tasks.locator("xpath=ancestor::*[@data-slot='popover-content']"),
    );
    await page.keyboard.press("Escape");

    // Each item opens what its desktop button opens, inside the screen.
    for (const [item, inside] of [
      [/^Email/, page.getByText(/^Email this Bot at its private address/)],
      [/^Channels/, page.getByRole("list", { name: "Channels" })],
    ] as const) {
      await menuButton.click();
      await page.getByRole("menuitem", { name: item }).click();
      await expect(inside.first()).toBeVisible();
      await expectWithinScreen(
        page,
        page.locator("[data-slot='popover-content']").filter({ has: inside }),
      );
      await page.keyboard.press("Escape");
    }

    await menuButton.click();
    await page.getByRole("menuitem", { name: /^Reset/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
