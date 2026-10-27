import type { Expect, Page } from "@playwright/test";

import type { HostFixture } from "./host";

/**
 * Page helpers a Host's tests use. `expect` comes in from the caller: this folder is never loaded
 * by Node, so it can't import `@playwright/test` itself.
 */
export function chatPage(expect: Expect, host: HostFixture) {
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
