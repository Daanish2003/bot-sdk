import { expect, test } from "@playwright/test";

import {
  imageMarker,
  imagePrompt,
  imageReply,
} from "../../../packages/chat-sdk/test/e2e/fake-ollama";
import { messageRows, signInAsSeededUserWithModel } from "./helpers";

test("a generated image shows inline, is still there after a reload, and downloads", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.getByLabel("Message", { exact: true }).fill(`${imageMarker} Draw a red bicycle`);
  await page.keyboard.press("Enter");

  // The image, inline in the reply, with its prompt as the caption and the reply's words after it.
  const reply = messageRows(page).last();
  const image = reply.getByRole("img", { name: imagePrompt });
  await expect(image).toBeVisible();
  await expect(reply).toContainText(imageReply);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  // Reloaded from the owner's route, the image is still there.
  await page.reload();
  const reloaded = messageRows(page).last().getByRole("img", { name: imagePrompt });
  await expect(reloaded).toBeVisible();

  // Download saves the file, named by the image's short id.
  await reloaded.hover();
  const download = page.waitForEvent("download");
  await messageRows(page).last().getByRole("link", { name: "Download" }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^generated-image-[0-9a-f]{8}\.png$/);
});
