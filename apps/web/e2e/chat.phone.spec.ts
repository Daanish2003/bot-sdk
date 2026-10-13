import { expect, type Page, test } from "@playwright/test";

import { mcpMarker, wideMarker } from "../../../packages/chat-sdk/test/e2e/fake-ollama";

import { messageRows, send, signInAsSeededUser, signInAsSeededUserWithModel } from "./helpers";

const trackerServer = "E2E Tracker";

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the Conversation panel is a drawer, closed until the menu opens it", async ({ page }) => {
  await signInAsSeededUserWithModel(page);
  await send(page, "A phone Conversation");
  const panel = page.getByRole("complementary", { name: "Conversations" });
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("link").first().click();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "New Conversation" }).click();
  await expect(page).toHaveURL(/\/c$/);
  await expect(panel).toBeHidden();
});

test("a Conversation fits the screen, with its title and Message actions showing", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await send(page, "Does this fit on a phone?");

  await expect(page.getByRole("banner").getByTitle("Rename")).toBeVisible();
  const titleBox = (await page.getByRole("banner").getByTitle("Rename").boundingBox())!;
  expect(titleBox.width).toBeGreaterThan(40);

  // No hover on a touch screen: Copy, Edit and Regenerate show without it.
  await expect(messageRows(page).first().getByRole("button", { name: "Edit" })).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(messageRows(page).last().getByRole("button", { name: "Regenerate" })).toHaveCSS(
    "opacity",
    "1",
  );
  await expectNoSidewaysScroll(page);
});

test("the login, Keys, Account and new Conversation pages fit the screen", async ({ page }) => {
  await page.goto("/login");
  await expectNoSidewaysScroll(page);
  await signInAsSeededUser(page);
  await expectNoSidewaysScroll(page);
  await page.goto("/settings/keys");
  await expect(page.getByRole("heading", { name: "Keys & settings" })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.goto("/settings/account");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("the composer's text is 16px, and a wide table and long code line scroll inside the reply", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await send(page, `${wideMarker} Show me a wide table`);
  await expect(messageRows(page).last()).toContainText("Column six");

  // 16px, so iOS doesn't zoom the page when the composer takes focus.
  await expect(page.getByLabel("Message", { exact: true })).toHaveCSS("font-size", "16px");
  await expectNoSidewaysScroll(page);
});

test("Approve and Deny fill the width of a phone", async ({ page }) => {
  await signInAsSeededUserWithModel(page);

  // Connect the tracker from the keys page, then switch it on for a Conversation.
  await page.goto("/settings/keys");
  const connection = page.getByRole("listitem").filter({ hasText: trackerServer });
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection).toContainText("Connected");
  await page.goto("/c");
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  await send(page, "Set up the tracker");
  await expect(page).toHaveURL(/\/c\/[\w-]+$/);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: trackerServer });
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // The fake Model asks for the tool: the call waits for Approval.
  await page.getByLabel("Message", { exact: true }).fill(`${mcpMarker} Open an issue`);
  await page.keyboard.press("Enter");
  await expect(messageRows(page).last()).toContainText("Waiting for approval");

  const approve = (await page.getByRole("button", { name: "Approve", exact: true }).boundingBox())!;
  const deny = (await page.getByRole("button", { name: "Deny", exact: true }).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(approve.width).toBeGreaterThan(viewport.width * 0.8);
  expect(deny.width).toBeGreaterThan(viewport.width * 0.8);
  expect(approve.height).toBeGreaterThanOrEqual(44);
});
