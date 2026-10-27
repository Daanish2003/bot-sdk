import { expect, type Page } from "@playwright/test";

import type { HostFixture } from "./host";

/** Page helpers a Host's tests use. */
export function chatPage(host: HostFixture) {
  /** Saves Ollama credentials pointing at the fake Ollama host, so its Model can be picked. */
  async function addFakeOllama(page: Page) {
    await page.goto(host.paths.keys);
    const row = page.getByRole("listitem").filter({ hasText: "Ollama" });
    await row.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Host", { exact: true }).fill(host.fakeOllamaHost);
    await page.getByRole("button", { name: "Check & save" }).click();
    await expect(row.getByText("Verified")).toBeVisible();
  }

  return { addFakeOllama };
}
