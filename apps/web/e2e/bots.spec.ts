import { expect, test } from "@playwright/test";

import { botReply, sendMarker } from "../../../packages/bot-sdk/test/e2e/fake-ollama";
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
