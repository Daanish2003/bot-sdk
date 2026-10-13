import { expect, test } from "@playwright/test";

import { messageRows, send, signInAsSeededUserWithModel } from "./helpers";

test("a Temporary Conversation stays out of the sidebar and is deleted from the header", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.getByRole("button", { name: "Temporary", exact: true }).click();
  await send(page, "Temporary hello");

  await expect(page).toHaveURL(/\/c\/[\w-]+/);
  await expect(messageRows(page).first()).toContainText("Temporary hello");
  await expect(page.getByRole("status").filter({ hasText: "Temporary chat:" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeHidden();

  const panel = page.getByRole("complementary", { name: "Conversations" });
  await expect(panel.getByRole("link")).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/c$/);
  await expect(messageRows(page)).toHaveCount(0);
});
