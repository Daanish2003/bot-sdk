import { expect, test, type Page } from "@playwright/test";

import { markdownMarker, sendMarker, unsafeMarker } from "./support/fake-ollama";

import { createBot, sendToBot, signInAsSeededUserWithModel } from "./helpers";

/** The safety rules and the look of a Bot's Message, in a real browser. */
async function expectDefused(message: ReturnType<Page["locator"]>, page: Page) {
  await expect(message.getByRole("heading", { name: "Safe heading" })).toBeVisible();
  await expect(message.getByRole("listitem")).toHaveCount(2);
  await expect(message).toContainText("2*3*4");
  await expect(message.locator("em")).toHaveCount(0);
  expect(await message.locator("script, img, iframe").count()).toBe(0);
  await expect(message.getByRole("link")).toHaveCount(0);
  await expect(message).toContainText("click me");
  await expect(message).toContainText("tracker");
  // The script never ran.
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
}

test("a Bot's Message is defused in Bot chat, and shows its time on hover and on focus", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("attacker.example")) remote.push(request.url());
  });
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Careful");
  await sendToBot(page, `${sendMarker} ${unsafeMarker}`);
  const reply = page.locator("[data-bot-message][data-role=assistant]").last();
  await expect(reply.getByRole("heading", { name: "Safe heading" })).toBeVisible();
  await expectDefused(reply, page);
  expect(remote).toEqual([]);

  // The time: hidden at rest, shown on hover and on keyboard focus.
  const root = reply.locator("xpath=..");
  const time = root.locator("[data-hover-time]");
  await page.mouse.move(0, 0);
  await expect(time).toHaveCSS("opacity", "0");
  await root.hover();
  await expect(time).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(time).toHaveCSS("opacity", "0");
  await root.focus();
  await expect(time).toHaveCSS("opacity", "1");
});

test("a Room's Bot Message is defused, with avatar, name and time, and the user's is a right bubble", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("attacker.example")) remote.push(request.url());
  });
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Room One");
  await createBot(page, "Room Two");
  await page.getByRole("button", { name: "New Room" }).click();
  await page.getByRole("textbox", { name: "Room name" }).fill("Safety Room");
  await page.getByRole("button", { name: "Room One" }).click();
  await page.getByRole("button", { name: "Room Two" }).click();
  await page.getByRole("button", { name: "Create Room" }).click();
  await expect(page.getByRole("heading", { name: "Safety Room" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${sendMarker} ${unsafeMarker} ${markdownMarker}`);
  await composer.press("Enter");

  const own = page.locator("[data-room-message] [data-bot-message][data-role=user]");
  await expect(own).toBeVisible();
  const thread = page.locator("[data-room-thread]");
  const reply = thread
    .locator("[data-room-message] [data-bot-message][data-role=assistant]")
    .last();
  await expect(reply.getByRole("heading", { name: "Safe heading" })).toBeVisible();
  await expectDefused(reply, page);
  expect(remote).toEqual([]);

  const entry = reply.locator("xpath=ancestor::*[@data-room-message]");
  await expect(entry.locator("[data-author]")).toHaveText(/Room (One|Two)/);
  await expect(entry.locator("[data-slot=bot-avatar]")).toBeVisible();
  await expect(entry.locator("time").first()).toBeVisible();

  const box = await own.boundingBox();
  const bounds = await thread.boundingBox();
  expect(box!.x + box!.width).toBeGreaterThan(bounds!.x + bounds!.width - 40);
});
