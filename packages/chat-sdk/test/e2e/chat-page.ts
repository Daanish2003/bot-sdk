import type { Expect, Page } from "@e2e-types/playwright-test";

import type { HostFixture } from "./host";

/**
 * Page helpers the shared scenarios and a Host's own tests both use. `expect` comes in from the
 * caller: this folder is never loaded by Node, so it can't import `@playwright/test` itself.
 */
export function chatPage(expect: Expect, host: HostFixture) {
  const messageRows = (page: Page) => page.locator("[data-message-id]");

  /** Sends `text` from the composer and waits for the whole reply. */
  async function send(page: Page, text: string) {
    // The composer ignores Enter while a reply streams; its button reads "Send" only once it is done.
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
    await expect(sendButton).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill(text);
    await page.keyboard.press("Enter");
    await expect(messageRows(page).last()).toContainText("That's all.");
    await expect(sendButton).toBeVisible();
  }

  /** Saves Ollama credentials pointing at the fake Ollama host, so its Model can be picked. */
  async function addFakeOllama(page: Page) {
    await page.goto(host.paths.keys);
    const row = page.getByRole("listitem").filter({ hasText: "Ollama" });
    await row.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Host", { exact: true }).fill(host.fakeOllamaHost);
    await page.getByRole("button", { name: "Check & save" }).click();
    await expect(row.getByText("Verified")).toBeVisible();
  }

  /** A seeded user on the new Conversation page. */
  async function signIn(page: Page) {
    await host.signIn(page);
    await page.goto(host.paths.newConversation);
  }

  /** A seeded user with the fake Ollama, on the new Conversation page, with its Model picked. */
  async function signInWithModel(page: Page) {
    await signIn(page);
    await addFakeOllama(page);
    await page.goto(host.paths.newConversation);
    await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  }

  return { messageRows, send, addFakeOllama, signIn, signInWithModel };
}
