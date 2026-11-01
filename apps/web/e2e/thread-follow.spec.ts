import { expect, type Locator, type Page, test } from "@playwright/test";

import { botReply, sendMarker } from "./support/fake-ollama";

import { createBot, sendToBot, signInAsSeededUserWithModel } from "./helpers";

/**
 * jsdom has no layout, so following and scroll position are proved here, in a real browser. The
 * thread grows with no new Message, as when highlighting finishes: the test grows the last child
 * in the page itself, so React renders nothing.
 */
const distanceFromEnd = (thread: Locator) =>
  thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

const scrollTo = (thread: Locator, top: number) =>
  thread.evaluate((element, at) => {
    element.scrollTop = at;
    element.dispatchEvent(new Event("scroll"));
  }, top);

const growLastChild = (thread: Locator, px: number) =>
  thread.evaluate((element, extra) => {
    const last = element.lastElementChild as HTMLElement;
    last.style.paddingBottom = `${extra}px`;
  }, px);

async function expectFollowsGrowth(thread: Locator) {
  await expect.poll(() => distanceFromEnd(thread)).toBeLessThan(2);

  // Near the end, content that grows by itself stays in view.
  await growLastChild(thread, 400);
  await expect.poll(() => distanceFromEnd(thread)).toBeLessThan(2);

  // Scrolled up to read, the same growth leaves the reader where they are.
  await scrollTo(thread, 0);
  await growLastChild(thread, 900);
  await page(thread).waitForTimeout(300);
  expect(await thread.evaluate((element) => element.scrollTop)).toBe(0);

  // Nothing in the thread gives up height to fit: each child keeps its own.
  const shrinking = await thread.evaluate(
    (element) =>
      [...element.children].filter((child) => getComputedStyle(child).flexShrink !== "0").length,
  );
  expect(shrinking).toBe(0);
}

const page = (locator: Locator): Page => locator.page();

test("a Bot's thread follows content that grows by itself, and leaves a reader scrolled up", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Grower");
  await sendToBot(page, `${sendMarker} ${"A long line\n".repeat(80)}`);
  await expect(page.locator("[data-bot-message]").last()).toHaveText(botReply);
  await expectFollowsGrowth(page.locator("[data-bot-thread]"));
});

test("a Room's thread follows content that grows by itself, and leaves a reader scrolled up", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Room One");
  await createBot(page, "Room Two");
  await page.getByRole("button", { name: "New Room" }).click();
  await page.getByRole("textbox", { name: "Room name" }).fill("Grow Room");
  await page.getByRole("button", { name: "Room One" }).click();
  await page.getByRole("button", { name: "Room Two" }).click();
  await page.getByRole("button", { name: "Create Room" }).click();
  await expect(page.getByRole("heading", { name: "Grow Room" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${"A long line\n".repeat(80)}`);
  await composer.press("Enter");
  const thread = page.locator("[data-room-thread]");
  await expect(thread).toContainText("A long line");
  await expectFollowsGrowth(thread);
});
