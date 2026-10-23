import { expect, test } from "@playwright/test";

import {
  imageMarker,
  imagePrompt,
  imageReply,
} from "../../../packages/bot-sdk/test/e2e/fake-ollama";
import { messageRows, signInAsSeededUserWithModel } from "./assistant-helpers";
import { appWebHost } from "./host";

test("a Shared link shows its Generated image to a signed-out viewer, who can download it", async ({
  page,
  browser,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.getByLabel("Message", { exact: true }).fill(`${imageMarker} Draw a red bicycle`);
  await page.keyboard.press("Enter");
  await expect(messageRows(page).last().getByRole("img", { name: imagePrompt })).toBeVisible();
  await expect(messageRows(page).last()).toContainText(imageReply);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create link" }).click();
  const url = await dialog.getByText(appWebHost.paths.sharedLink).textContent();

  // A signed-out visitor, in a fresh browser context, sees the image in full.
  const visitor = await browser.newPage();
  await visitor.goto(url!);
  const image = visitor.getByRole("img", { name: imagePrompt });
  await expect(image).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // Download saves the file, named by the image's short id.
  await image.hover();
  const download = visitor.waitForEvent("download");
  await visitor.getByRole("link", { name: "Download" }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^generated-image-[0-9a-f]{8}\.png$/);
  await visitor.close();
});
