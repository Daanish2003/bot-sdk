import { readFile } from "node:fs/promises";

import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "@e2e-types/playwright-test";

import { chatPage } from "./chat-page";
import { slowMarker } from "./fake-ollama";
import type { HostFixture } from "./host";

/**
 * The end-to-end scenarios every Host runs: send and stream, Stop, re-attach on reload, edit and
 * Branch, Shared link, delete. Each Host passes its fixture (`host.ts`) and its `test`; the Host's
 * web server is its own Playwright config's job.
 */
export function registerSharedScenarios(
  test: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >,
  host: HostFixture,
) {
  const { expect } = test;
  const { messageRows, send, signInWithModel } = chatPage(expect, host);

  test.describe("shared scenarios", () => {
    test("the first Message of a new Conversation is sent, streamed and kept", async ({ page }) => {
      await signInWithModel(page);

      await send(page, "Hello from the end-to-end test");

      await expect(page).toHaveURL(host.paths.conversation);
      await expect(messageRows(page)).toHaveCount(2);
      await expect(messageRows(page).first()).toContainText("Hello from the end-to-end test");
      await expect(messageRows(page).last()).toContainText("const answer = 42;");
      // A live-listed Model's badge is its name, not its "provider:model" id.
      await expect(messageRows(page).last()).toContainText("e2e-model");
      await expect(messageRows(page).last()).not.toContainText("ollama:");

      await page.reload();
      await expect(messageRows(page)).toHaveCount(2);
      await expect(messageRows(page).last()).toContainText("That's all.");
      await expect(
        page.getByRole("complementary", { name: "Conversations" }).getByRole("link"),
      ).toHaveCount(1);
    });

    test("a follow-up continues the Conversation", async ({ page }) => {
      await signInWithModel(page);
      await send(page, "First question");
      await send(page, "Second question");

      await expect(messageRows(page)).toHaveCount(4);
      await expect(messageRows(page).nth(2)).toContainText("Second question");
    });

    test("Stop ends a reply early and marks it Stopped", async ({ page }) => {
      await signInWithModel(page);
      await page.getByLabel("Message", { exact: true }).fill(`Take your time ${slowMarker}`);
      await page.keyboard.press("Enter");

      const stop = page.getByRole("button", { name: "Stop" });
      await expect(messageRows(page).last()).toContainText("You said");
      await stop.click();

      await expect(messageRows(page).last()).toContainText("Stopped");
      await expect(messageRows(page).last()).not.toContainText("That's all.");
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    });

    test("reloading during a streaming reply joins it live until it completes", async ({
      page,
    }) => {
      await signInWithModel(page);
      await page.getByLabel("Message", { exact: true }).fill(`Keep going ${slowMarker}`);
      await page.keyboard.press("Enter");
      await expect(messageRows(page).last()).toContainText("You said");

      await page.reload();

      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await expect(messageRows(page).last()).toContainText("That's all.");
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
      await page.reload();
      await expect(messageRows(page)).toHaveCount(2);
      await expect(messageRows(page).last()).toContainText("That's all.");
    });

    test("editing a Message and regenerating a reply each start a new Branch", async ({ page }) => {
      await signInWithModel(page);
      await send(page, "Original question");

      const userRow = messageRows(page).first();
      await userRow.hover();
      await userRow.getByRole("button", { name: "Edit" }).click();
      await userRow.getByLabel("Edit Message").fill("Edited question");
      await userRow.getByRole("button", { name: "Save & submit" }).click();
      await expect(messageRows(page).last()).toContainText("Edited question");
      await expect(messageRows(page).last()).toContainText("That's all.");
      await expect(messageRows(page).first()).toContainText("2/2");

      await messageRows(page).first().getByRole("button", { name: "Previous Branch" }).click();
      await expect(messageRows(page).first()).toContainText("Original question");
      await expect(messageRows(page).first()).toContainText("1/2");

      const reply = messageRows(page).last();
      await reply.hover();
      await reply.getByRole("button", { name: "Regenerate" }).click();
      await expect(messageRows(page).last()).toContainText("2/2");
      await expect(messageRows(page).last()).toContainText("That's all.");
    });

    test("a Shared link shows the Conversation read-only to anyone", async ({ page, browser }) => {
      await signInWithModel(page);
      await send(page, "Something worth sharing");

      await page.getByRole("button", { name: "Share" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Create link" }).click();
      const url = await dialog.getByText(host.paths.sharedLink).textContent();

      // The link row stays inside the dialog.
      expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);

      const visitor = await browser.newPage();
      await visitor.goto(url!);
      await expect(visitor.getByText("Something worth sharing").first()).toBeVisible();
      await expect(visitor.getByRole("button", { name: "Edit" })).toHaveCount(0);

      await visitor.goto(host.paths.shared("no-such-token"));
      await expect(visitor.getByText("Shared link not found")).toBeVisible();
      await visitor.close();
    });

    test("deleting a Conversation confirms, then removes it from the panel", async ({ page }) => {
      await signInWithModel(page);
      await send(page, "Delete me");
      await expect(page).toHaveURL(host.paths.conversation);
      const panel = page.getByRole("complementary", { name: "Conversations" });
      await expect(panel.getByRole("link")).toHaveCount(1);

      // The browser's confirm dialog says yes.
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: /^Actions for / }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

      await expect(panel.getByRole("link")).toHaveCount(0);
      await expect(page).not.toHaveURL(host.paths.conversation);
    });

    test("an archived Conversation leaves the sidebar, and sending it a Message brings it back", async ({
      page,
    }) => {
      await signInWithModel(page);
      await send(page, "Archive this one");
      await expect(page).toHaveURL(host.paths.conversation);
      const conversationPath = new URL(page.url()).pathname;
      const panel = page.getByRole("complementary", { name: "Conversations" });
      await expect(panel.locator(`a[href="${conversationPath}"]`)).toBeVisible();

      await page.getByRole("button", { name: /^Actions for / }).click();
      await page.getByRole("menuitem", { name: "Archive", exact: true }).click();

      // It leaves the sidebar, and its page says so.
      await expect(panel.locator(`a[href="${conversationPath}"]`)).toHaveCount(0);
      await expect(page.getByText("This Conversation is archived.")).toBeVisible();

      // Sending a Message unarchives it, and it returns to the sidebar.
      await send(page, "Bring it back");
      await expect(panel.locator(`a[href="${conversationPath}"]`)).toBeVisible();
      await expect(page.getByText("This Conversation is archived.")).toHaveCount(0);
    });

    test("Export as Markdown downloads the Conversation with its headings", async ({ page }) => {
      await signInWithModel(page);
      await send(page, "Export me");
      await expect(messageRows(page)).toHaveCount(2);
      await expect(messageRows(page).last()).toContainText("That's all.");

      await page.getByRole("button", { name: "Conversation menu" }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Export as Markdown" }).click(),
      ]);

      expect(download.suggestedFilename()).toMatch(/\.md$/);
      const markdown = await readFile((await download.path())!, "utf8");
      expect(markdown).toMatch(/^# .+$/m);
      expect(markdown).toContain("## You\n\nExport me");
      expect(markdown).toMatch(/^## Assistant · .+$/m);
    });

    test("a Project holds its chats, Pinned lists the pinned ones, and the main list pages on scroll", async ({
      page,
    }) => {
      await signInWithModel(page);
      const panel = page.getByRole("complementary", { name: "Conversations" });

      await panel.getByRole("button", { name: "New Project" }).click();
      await panel.getByLabel("Project name").fill("E2E Project");
      await panel.getByRole("button", { name: "Create" }).click();
      await expect(page).toHaveURL(/\/p\/[\w-]+$/);
      const projectPath = new URL(page.url()).pathname;

      // The Project's default Model, which its new chats start on.
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("Default Model").click();
      await page.getByRole("option", { name: "e2e-model" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project saved")).toBeVisible();

      await page.getByRole("link", { name: "New chat in this Project" }).click();
      await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
      await send(page, "A question for the Project");
      await expect(page).toHaveURL(host.paths.conversation);
      const conversationPath = new URL(page.url()).pathname;

      // In the Project, not in the main list.
      await page.goto(projectPath);
      await expect(page.locator(`a[href="${conversationPath}"]`)).toBeVisible();
      await expect(panel.locator(`a[href="${conversationPath}"]`)).toHaveCount(0);

      await page.getByRole("button", { name: /^Actions for / }).click();
      await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

      // Pinned lists it, and the Project still holds it.
      const pinned = panel.getByRole("region", { name: "Pinned" });
      await expect(pinned.locator(`a[href="${conversationPath}"]`)).toBeVisible();
      await expect(page.locator(`a[href="${conversationPath}"]`)).toHaveCount(2);

      // More than one page of Conversations outside Projects, seeded through the chat's RPC.
      const mainCount = 55;
      for (let i = 0; i < mainCount; i++) {
        const response = await page.request.post(`${host.paths.chatApi}/rpc/conversation/create`, {
          data: { json: { model: "ollama:e2e-model" } },
        });
        expect(response.ok()).toBe(true);
      }

      await page.goto(host.paths.newConversation);
      // The Pinned one, then the first page of 50 outside Projects.
      const rows = panel.locator('a[href^="/c/"]');
      await expect(rows).toHaveCount(51);
      await expect(pinned.locator(`a[href="${conversationPath}"]`)).toBeVisible();

      // Scrolling to the end of the list loads the second page.
      await expect
        .poll(async () => {
          await rows.last().scrollIntoViewIfNeeded();
          return rows.count();
        })
        .toBe(1 + mainCount);
    });
  });
}
