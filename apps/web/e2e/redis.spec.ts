import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { fakeOllamaHost } from "./env";
import { slowCallsPath, slowMarker } from "./support/fake-ollama";
import { createBot, sendToBot, signInAsSeededUserWithModel } from "./helpers";

// Runs only when the e2e run has REDIS_URL (playwright.config.ts), so the server shares its Turns'
// changes through Redis (ADR 0006) instead of memory.

test("a second tab sees a Bot working, and its Stop stops the Turn in both tabs", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Slowpoke");
  const prompt = `Keep going ${slowMarker} ${randomUUID()}`;
  await sendToBot(page, prompt);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // Wait for the Turn's Model call, so its job has started. Until the Message's batch closes, about
  // 500 ms after the send, the job is still queued: a Stop then ends the Turn at once, without
  // having to reach a running attempt.
  const modelCallOpen = async () => {
    const calls = (await (await fetch(`${fakeOllamaHost}${slowCallsPath}`)).json()) as string[];
    return calls.some((call) => call.includes(prompt));
  };
  await expect.poll(modelCallOpen).toBe(true);

  // Another tab of the same user, opened on the Bot while its Turn still runs.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await expect(second.getByRole("button", { name: "Stop" })).toBeVisible();

  await second.getByRole("button", { name: "Stop" }).click();
  await expect(second.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 3_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 3_000 });
  // The Stop reached the Model too, which would otherwise go on generating and billing.
  await expect.poll(modelCallOpen, { timeout: 3_000 }).toBe(false);
  await second.close();
});
