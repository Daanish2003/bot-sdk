import { expect, test } from "@playwright/test";

import { messageRows, send, signInAsSeededUserWithModel } from "./helpers";

test("Instructions are saved in settings, and a reply's tokens show in its info popover", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  await page.goto("/settings/keys");
  const instructions = "Answer briefly. Use British spelling.";
  const form = page.locator("form").filter({ has: page.getByLabel("Your Instructions") });
  await form.getByLabel("Your Instructions").fill(instructions);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Instructions saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Your Instructions")).toHaveValue(instructions);

  await page.goto("/c");
  await send(page, "Tell me the time");

  const reply = messageRows(page).last();
  await reply.getByRole("button", { name: "Token usage" }).click();
  const popover = page.getByRole("dialog");
  // The fake Ollama host reports prompt_eval_count 1 and eval_count 1 for each reply.
  await expect(popover.locator("dt:text-is('Input') + dd")).toHaveText("1");
  await expect(popover.locator("dt:text-is('Output') + dd")).toHaveText("1");
});
