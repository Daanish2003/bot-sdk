import { expect, test } from "@playwright/test";

import { slowMarker } from "../../../packages/chat-sdk/test/e2e/fake-ollama";
import { messageRows, signInAsSeededUserWithModel } from "./helpers";

// Runs only when the e2e run has REDIS_URL (playwright.config.ts), so the server shares its Runs
// through Redis (ADR 0006) instead of memory.

test("a second tab re-attaches to a running reply, and its Stop stops the reply", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.getByLabel("Message", { exact: true }).fill(`Keep going ${slowMarker}`);
  await page.keyboard.press("Enter");
  await expect(messageRows(page).last()).toContainText("You said");
  await expect(page).toHaveURL(/\/c\/[\w-]+$/);

  // Another tab of the same user, opened on the Conversation while the reply still streams.
  const second = await page.context().newPage();
  await second.goto(new URL(page.url()).pathname);
  await expect(second.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(messageRows(second).last()).toContainText("You said");

  await second.getByRole("button", { name: "Stop" }).click();
  await expect(messageRows(second).last()).toContainText("Stopped");
  await expect(messageRows(page).last()).toContainText("Stopped");
  await expect(messageRows(page).last()).not.toContainText("That's all.");
  await expect(second.getByRole("button", { name: "Send" })).toBeVisible();
  await second.close();
});
