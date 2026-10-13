import { expect, test } from "@playwright/test";

import { artifactMarker, dataPath } from "../../../packages/chat-sdk/test/e2e/fake-ollama";

import { fakeOllamaHost } from "./env";
import { messageRows, signInAsSeededUserWithModel } from "./helpers";

test("at phone width the Artifact panel fills the screen, and close returns to the chat", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page
    .getByLabel("Message", { exact: true })
    .fill(`${artifactMarker} ${fakeOllamaHost}${dataPath}`);
  await page.keyboard.press("Enter");
  await expect(messageRows(page).last()).toContainText("Saved version 1");

  // A reload loads the Message with its saved id, which the panel's version request needs.
  await page.reload();
  await page.locator("[data-artifact-card]").click();
  const panel = page.locator("[data-artifact-panel]");
  await expect(panel).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.y).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(viewport.width, 0);
  expect(box.height).toBeCloseTo(viewport.height, 0);

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await expect(messageRows(page).first()).toBeVisible();
  await expect(page.locator("[data-artifact-card]")).toBeVisible();
});
