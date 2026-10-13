import { expect, test } from "@playwright/test";

import {
  knowledgeFileName,
  knowledgeMarker,
  knowledgePassage,
} from "../../../packages/chat-sdk/test/e2e/fake-ollama";
import { messageRows, signInAsSeededUserWithModel } from "./helpers";

test("a Knowledge file reaches Ready, and the assistant's answer cites its passage", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  // A Project, with a Markdown Knowledge file uploaded on its Knowledge tab and read to Ready.
  await page.getByRole("button", { name: "New Project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Launch");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/[\w-]+$/);
  await page.getByRole("tab", { name: "Knowledge" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: knowledgeFileName,
    mimeType: "text/markdown",
    buffer: Buffer.from(`# Launch brief\n\n${knowledgePassage}\n`),
  });
  const files = page.getByRole("table");
  await expect(files).toContainText(knowledgeFileName);
  await expect(files.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });

  // A question in the Project: the assistant searches the file, and its reply cites the passage
  // as an Excerpt chip, whose popover shows the passage.
  await page.getByRole("link", { name: "New chat in this Project" }).click();
  await page.getByLabel("Message", { exact: true }).fill(`${knowledgeMarker} When is the launch?`);
  await page.keyboard.press("Enter");
  const chip = messageRows(page).last().getByRole("button", { name: "Excerpt 1", exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  const popover = page.getByRole("dialog").filter({ hasText: knowledgePassage });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(knowledgeFileName);
});
