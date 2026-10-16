import { expect, test } from "@playwright/test";

import { rememberedFact } from "../../../packages/bot-sdk/test/e2e/fake-ollama";
import { appWebHost } from "./host";
import { messageRows, send, signInAsSeededUserWithModel } from "./helpers";

test("a Memory the user asks for is shown in its reply's chip, and can be deleted on the Memory page", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  // The user asks the assistant to remember a fact. The Memory job runs after the reply, and its
  // chip shows the one change it made (#290).
  await send(page, "remember that I'm vegetarian");
  const chip = messageRows(page).last().getByRole("button", {
    name: "Memory updated · 1 change",
    exact: true,
  });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.getByRole("dialog").getByText(`Added: ${rememberedFact}`)).toBeVisible();

  // The Memory page, in Keys & settings, lists it; the user deletes it.
  await page.goto(appWebHost.paths.keys);
  const memory = page.getByRole("listitem").filter({ hasText: rememberedFact });
  await expect(memory).toBeVisible();
  await memory.getByRole("button", { name: "Delete Memory", exact: true }).click();
  await expect(memory).toHaveCount(0);
});
