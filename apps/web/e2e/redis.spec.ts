import { expect, test } from "@playwright/test";

import { slowMarker } from "./support/fake-ollama";
import { createBot, sendToBot, signInAsSeededUserWithModel } from "./helpers";

// Runs only when the e2e run has REDIS_URL (playwright.config.ts), so the server shares its Turns'
// changes through Redis (ADR 0006) instead of memory.

test("a second tab sees a Bot working, and its Stop stops the Turn in both tabs", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Slowpoke");
  await sendToBot(page, `Keep going ${slowMarker}`);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // Another tab of the same user, opened on the Bot while its Turn still runs.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await expect(second.getByRole("button", { name: "Stop" })).toBeVisible();

  await second.getByRole("button", { name: "Stop" }).click();
  await expect(second.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 3_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 3_000 });
  await second.close();
});
