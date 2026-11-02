import { expect, test } from "@playwright/test";

import {
  assignedBotName,
  assignmentInstructions,
  assignmentTitle,
  assignMarker,
  botReply,
  fileReply,
  markdownMarker,
  sendMarker,
} from "./support/fake-ollama";
import { appWebHost } from "./host";
import { signInAsSeededUserWithModel } from "./helpers";

test("a Bot replies in a bubble, then stays quiet and shows Seen ✓", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/bots\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Scout" })).toBeVisible();

  const bubbles = page.locator("[data-bot-message]");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${sendMarker} Say hello`);
  await composer.press("Enter");

  await expect(bubbles.last()).toHaveText(botReply);
  await expect(bubbles.last()).toHaveAttribute("data-role", "assistant");
  await expect(page.getByRole("status", { name: "Typing" })).toBeHidden();
  await expect(page.getByText("Seen ✓")).toBeHidden();

  await composer.fill("ok");
  await composer.press("Enter");

  await expect(page.getByText("Seen ✓")).toBeVisible();
  await expect(bubbles).toHaveCount(3);
  await expect(bubbles.last()).toHaveText("ok");
  await expect(bubbles.last()).toHaveAttribute("data-role", "user");
});

test("a Bot's Markdown reads as a document, and the user's own text stays as typed", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Writer");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/bots\/[\w-]+$/);

  const composer = page.getByRole("textbox", { name: "Message" });
  const typed = `${sendMarker} ${markdownMarker} **as typed**`;
  await composer.fill(typed);
  await composer.press("Enter");

  const reply = page.locator("[data-bot-message][data-role=assistant]").last();
  await expect(reply.getByRole("heading", { name: "Release notes" })).toBeVisible();
  await expect(reply).not.toContainText("**");
  await expect(reply).not.toContainText("##");
  await expect(reply.getByRole("row")).toHaveCount(2);

  // The styles reach the page, so unstyled tags don't pass for formatting.
  const bold = await reply.locator("strong").evaluate((el) => getComputedStyle(el).fontWeight);
  expect(Number(bold)).toBeGreaterThanOrEqual(600);
  await expect(reply.locator("ul")).toHaveCSS("list-style-type", "disc");
  const size = (selector: string) =>
    reply.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await size("h2")).toBeGreaterThan(await size("p >> nth=0"));

  await expect(reply.locator("pre.shiki")).toContainText("const answer: number = 42;");
  await expect(reply.locator("pre.shiki span").first()).toBeVisible();

  const link = reply.getByRole("link", { name: "the docs" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("title", "https://example.com/docs");

  // Raw HTML shows as harmless text.
  await expect(reply).toContainText("<b>raw tag</b>");
  await expect(reply.locator("b")).toHaveCount(0);

  await expect(page.locator("[data-bot-message][data-role=user]").last()).toHaveText(typed);

  // The Bot's Message fills a centered column.
  const box = (await reply.boundingBox())!;
  const thread = (await page.locator("[data-bot-thread]").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(768);
  expect(box.width).toBeGreaterThan(Math.min(600, thread.width - 64));
  expect(Math.abs(box.x - thread.x - (thread.width - box.width) / 2)).toBeLessThanOrEqual(8);
});

test("a user sends a Bot a file, and the Bot's reply uses it", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Reader");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Reader" })).toBeVisible();

  await page.locator("[data-attach-input]").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("remember the milk"),
  });
  const chip = page.locator("[data-draft-files] [data-slot=attachment]");
  await expect(chip).toContainText("notes.txt");
  // Send waits for the upload, then the chip is gone and the file shows on the user's Message.
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${sendMarker} Read this`);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");

  await expect(chip).toHaveCount(0);
  await expect(page.locator("[data-files-card] [data-file]")).toContainText("notes.txt");
  const bubbles = page.locator("[data-bot-message]");
  await expect(bubbles.last()).toContainText(fileReply("notes.txt"), { timeout: 30_000 });
  await expect(bubbles.last()).toHaveAttribute("data-role", "assistant");
  // A user's attachments sit on the right of the column, sized to the files.
  const card = (await page.locator("[data-files-card]").boundingBox())!;
  const thread = (await page.locator("[data-bot-thread]").boundingBox())!;
  const columnEnd = thread.x + (thread.width + Math.min(thread.width, 768)) / 2;
  expect(card.x + card.width).toBeGreaterThan(columnEnd - 40);
  expect(card.width).toBeLessThan(576 + 1);
});

test("a long thread follows new Messages, stays put when scrolled up, and never squashes a card", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Longwinded");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Longwinded" })).toBeVisible();

  const thread = page.locator("[data-bot-thread]");
  const distanceFromEnd = () =>
    thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };

  await send(`${sendMarker} ${"A very long line\n".repeat(80)}`);
  await expect(page.locator("[data-bot-message]").last()).toHaveText(botReply);
  await expect.poll(distanceFromEnd).toBeLessThan(2);

  // Opens at the newest Message.
  await page.reload();
  await expect(page.locator("[data-bot-message]").last()).toHaveText(botReply);
  await expect.poll(distanceFromEnd).toBeLessThan(2);

  // Nothing in the thread gives up height to fit: each child keeps its own.
  const shrinking = await thread.evaluate(
    (element) =>
      [...element.children].filter((child) => getComputedStyle(child).flexShrink !== "0").length,
  );
  expect(shrinking).toBe(0);

  // Scrolled up to read, a Bot's Message doesn't move the page, and the user's own send does.
  await thread.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await send("ok");
  await expect.poll(distanceFromEnd).toBeLessThan(2);
});

test("a Bot assigns work to another, which shows collapsed in its Conversation and in its Tasks", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  const newBot = async (name: string) => {
    await page.goto("/bots");
    await page.getByRole("button", { name: "New Bot" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/bots\/[\w-]+$/);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    return page.url();
  };
  const writer = await newBot(assignedBotName);
  await newBot("Scout");

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${assignMarker} Get the post written.`);
  await composer.press("Enter");
  await expect(page.locator("[data-bot-message][data-role=assistant]").last()).toBeVisible();

  await page.goto(writer);
  const item = page.getByRole("button", { name: new RegExp(assignmentTitle) });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Scout");
  await expect(page.getByText(assignmentInstructions)).toBeHidden();
  await item.click();
  await expect(page.getByText(assignmentInstructions)).toBeVisible();

  await page.getByRole("button", { name: /^Tasks/ }).click();
  await expect(
    page
      .getByRole("tabpanel", { name: "In progress" })
      .getByRole("button", { name: new RegExp(assignmentTitle) }),
  ).toBeVisible();
});

test("/ lands on /bots", async ({ page }) => {
  await appWebHost.signIn(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/bots$/);
});
