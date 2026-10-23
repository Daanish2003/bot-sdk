import { expect, test } from "@playwright/test";

import { createBot, signInAsSeededUserWithModel } from "./helpers";

test("with no MCP server configured, the keys page has no Connections and a Bot's composer no Tools menu", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  await page.goto("/settings/keys");
  await expect(page.getByRole("listitem").filter({ hasText: "Ollama" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);

  await createBot(page, "Plain");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
});
