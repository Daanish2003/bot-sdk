import { expect, test } from "@playwright/test";

import { fakeOllamaHost } from "./env";
import {
  fetchedPagePath,
  fetchedPageText,
  fetchMarker,
} from "../../../packages/chat-sdk/test/e2e/fake-ollama";
import { messageRows, signInAsSeededUserWithModel } from "./helpers";

test("a linked page is read with the Web toggle on, and the reply cites it", async ({ page }) => {
  await signInAsSeededUserWithModel(page);

  const web = page.getByRole("button", { name: "Web", exact: true });
  if ((await web.getAttribute("aria-pressed")) !== "true") await web.click();
  await expect(web).toHaveAttribute("aria-pressed", "true");

  const pageUrl = `${fakeOllamaHost}${fetchedPagePath}`;
  await page.getByLabel("Message", { exact: true }).fill(`${fetchMarker} Summarise ${pageUrl}`);
  await page.keyboard.press("Enter");

  const reply = messageRows(page).last();
  // The call's row, with its state, and the Source chip for the page it read.
  const row = page.getByRole("button", { name: /fetch_url/ });
  await expect(row).toContainText("Done");
  await expect(reply.locator(`a[href="${pageUrl}"]`).first()).toBeVisible();

  // The finished reply, quoting the page and citing it by its link.
  await expect(reply).toContainText(fetchedPageText);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});
