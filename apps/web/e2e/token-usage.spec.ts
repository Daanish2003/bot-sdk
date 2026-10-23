import { expect, test } from "@playwright/test";

import { messageRows, send, signInAsSeededUserWithModel } from "./helpers";

// Instructions left the Keys page with #812; the assistant routes keep the token popover until spec 3.
test("a reply's tokens show in its info popover", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  // The composer can't send until the Model is known from the models list, which loads after the page does.
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  await send(page, "Tell me the time");

  const reply = messageRows(page).last();
  await reply.getByRole("button", { name: "Token usage" }).click();
  const popover = page.getByRole("dialog");
  // The fake Ollama host reports prompt_eval_count 1 and eval_count 1 for each reply.
  await expect(popover.locator("dt:text-is('Input') + dd")).toHaveText("1");
  await expect(popover.locator("dt:text-is('Output') + dd")).toHaveText("1");
});
