import type {
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "@e2e-types/playwright-test";

import { chatPage } from "./chat-page";
import {
  artifactMarker,
  artifactTitle,
  dataPath,
  revisedHeading,
  updateMarker,
} from "./fake-ollama";
import type { HostFixture } from "./host";

/**
 * The Artifact scenarios every Host runs (spec #304, ADR 0016): the fake Model creates an HTML
 * Artifact and updates it, and the panel shows the result in the sandboxed frame. Each Host passes
 * its fixture (`host.ts`) and its `test`; the Host's web server is its own Playwright config's job.
 */
export function registerArtifactScenarios(
  test: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >,
  host: HostFixture,
) {
  const { expect } = test;
  const { messageRows, signInWithModel } = chatPage(expect, host);

  const panel = (page: Page) => page.locator("[data-artifact-panel]");
  const cards = (page: Page) => page.locator("[data-artifact-card]");
  const frame = (page: Page) => page.locator(`iframe[title="${artifactTitle}"]`);
  const preview = (page: Page) => page.frameLocator(`iframe[title="${artifactTitle}"]`);
  const dataUrl = `${host.fakeOllamaHost}${dataPath}`;

  /** Sends `text` and waits for the last reply to say `reply`, then for the composer to be ready. */
  async function sendFor(page: Page, text: string, reply: string) {
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
    await expect(sendButton).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill(text);
    await page.keyboard.press("Enter");
    await expect(messageRows(page).last()).toContainText(reply);
    await expect(sendButton).toBeVisible();
  }

  /** A seeded user with the fake Ollama, and an Artifact made: its version 1 open in the panel. */
  async function makeArtifact(page: Page) {
    await signInWithModel(page);
    await sendFor(page, `${artifactMarker} ${dataUrl}`, "Saved version 1");
    await cards(page).first().click();
    await expect(panel(page)).toBeVisible();
  }

  test.describe("artifact scenarios", () => {
    test("making an Artifact opens the panel on its preview", async ({ page }) => {
      await signInWithModel(page);
      await sendFor(page, `${artifactMarker} ${dataUrl}`, "Saved version 1");

      await expect(panel(page)).toBeVisible();
      await expect(preview(page).getByRole("heading", { name: artifactTitle })).toBeVisible();
    });

    test("the card reads Created v1, and a reload keeps it", async ({ page }) => {
      await signInWithModel(page);
      await sendFor(page, `${artifactMarker} ${dataUrl}`, "Saved version 1");
      await expect(cards(page).first().getByRole("status")).toHaveText("Created v1 · HTML");

      await page.reload();
      await expect(cards(page).first().getByRole("status")).toHaveText("Created v1 · HTML");
      await cards(page).first().click();
      await expect(preview(page).getByRole("heading", { name: artifactTitle })).toBeVisible();
    });

    test("an update makes v2, and the Version list offers v2 and v1", async ({ page }) => {
      await makeArtifact(page);
      await sendFor(page, `${updateMarker} Revise it`, "Saved version 2");

      await expect(cards(page).last().getByRole("status")).toHaveText("Updated to v2");
      await cards(page).last().click();
      await expect(preview(page).getByRole("heading", { name: revisedHeading })).toBeVisible();

      const version = page.getByRole("combobox", { name: "Version" });
      await expect(version).toHaveValue("2");
      await expect(version.locator("option")).toHaveText(["v2 (latest)", "v1"]);
    });

    test("the preview's fetch is blocked by the frame's CSP", async ({ page }) => {
      await makeArtifact(page);

      // The fake host allows the read (CORS), so only the frame's `connect-src 'none'` blocks it.
      await expect(preview(page).locator("#fetch")).toHaveText("fetch: blocked");
    });

    test("the preview cannot read the parent page or cookies, and its frame is sandboxed without same-origin", async ({
      page,
    }) => {
      await makeArtifact(page);

      await expect(preview(page).locator("#parent")).toHaveText("parent: blocked");
      await expect(preview(page).locator("#cookie")).toHaveText("cookie: blocked");
      await expect(frame(page)).toHaveAttribute("sandbox", "allow-scripts");
    });

    test("a preview whose content shrinks makes its frame shrink", async ({ page }) => {
      await makeArtifact(page);
      const height = () => frame(page).evaluate((element) => parseFloat(element.style.height));

      // The page is about 900px tall until its "Shrink" button empties the tall block.
      await expect.poll(height).toBeGreaterThan(600);
      await preview(page).getByRole("button", { name: "Shrink" }).click();
      await expect.poll(height).toBeLessThan(400);
    });

    test("a script error in the preview shows a banner, and the preview keeps running", async ({
      page,
    }) => {
      await makeArtifact(page);
      await preview(page).getByRole("button", { name: "Break" }).click();

      await expect(panel(page).getByRole("alert")).toContainText("The preview hit an error");
      await expect(panel(page).getByRole("alert")).toContainText("boom");
      await expect(preview(page).locator("#fetch")).toHaveText("fetch: blocked");
    });

    test("a Shared link made at v1, after the owner updates to v2, shows only v1, read-only, with its preview running", async ({
      page,
      browser,
    }) => {
      await makeArtifact(page);

      await page.getByRole("button", { name: "Share" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Create link" }).click();
      const url = await dialog.getByText(host.paths.sharedLink).textContent();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      await sendFor(page, `${updateMarker} Revise it`, "Saved version 2");

      const visitor = await browser.newPage();
      await visitor.goto(url!);
      await visitor.locator("[data-artifact-card]").first().click();
      const shared = visitor.frameLocator(`iframe[title="${artifactTitle}"]`);
      await expect(shared.getByRole("heading", { name: artifactTitle })).toBeVisible();
      await expect(shared.getByRole("heading", { name: revisedHeading })).toHaveCount(0);
      await expect(visitor.getByText("Shared link · read-only")).toBeVisible();
      await expect(visitor.getByRole("combobox", { name: "Version" })).toHaveCount(0);
      // The preview still runs in the Shared link: its script reports the blocked fetch.
      await expect(shared.locator("#fetch")).toHaveText("fetch: blocked");
      await visitor.close();
    });
  });
}
