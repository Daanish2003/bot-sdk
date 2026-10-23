import { expect, test } from "@playwright/test";

import { botReply, fileReply, sendMarker } from "../../../packages/bot-sdk/test/e2e/fake-ollama";
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
});

test("/ lands on /bots", async ({ page }) => {
  await appWebHost.signIn(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/bots$/);
});
