import { expect, type Page, test } from "@playwright/test";

import { addFakeOllama, messageRows, send } from "./helpers";
import { appWebHost } from "./host";

/** The Quota banner above the composer, shown once the Quota is spent and the Model is a Host's. */
const quotaBanner = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "You've used your Quota" });

/** The Host's Model in the open Model picker. */
const hostOption = (page: Page) =>
  page.getByRole("group").getByRole("button").filter({ hasText: "e2e-model" });

test("a user with no key of their own uses up the Quota, then adds a key and carries on", async ({
  page,
}) => {
  await appWebHost.signIn(page);
  await page.goto(appWebHost.paths.newConversation);
  // No key of their own: the Host's Model is the one the composer starts on.
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");

  await send(page, "First question, on the Host's Model");
  await expect(page).toHaveURL(appWebHost.paths.conversation);
  const conversationUrl = page.url();

  // That Run spent the whole Quota: the Host's Models are off until it resets, with a way out.
  const banner = quotaBanner(page);
  await expect(banner).toContainText("Host Models are off until");
  await expect(banner.getByRole("link", { name: "Add your own key" })).toBeVisible();
  await page.getByRole("button", { name: "Model" }).click();
  await expect(hostOption(page)).toBeDisabled();
  await expect(hostOption(page)).toHaveAttribute("title", /Host Models are off until/);
  await page.keyboard.press("Escape");

  await banner.getByRole("link", { name: "Add your own key" }).click();
  await expect(page).toHaveURL(/\/settings\/keys$/);
  await addFakeOllama(page);

  // The own key runs the same Model, unmetered: the banner goes, and the reply completes.
  await page.goto(conversationUrl);
  await expect(quotaBanner(page)).toHaveCount(0);
  await send(page, "Second question, on the user's own key");
  await expect(messageRows(page)).toHaveCount(4);
  await expect(messageRows(page).last()).toContainText("That's all.");
});

test("the server refuses a Host Run past the Quota, even from a tab that hasn't seen it spent", async ({
  page,
}) => {
  await appWebHost.signIn(page);
  await page.goto(appWebHost.paths.newConversation);
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");

  // A second tab, loaded before the Quota is spent: its meter still shows the Quota unspent.
  const stale = await page.context().newPage();
  await stale.goto(appWebHost.paths.newConversation);
  await expect(stale.getByRole("button", { name: "Model" })).toContainText("e2e-model");

  await send(page, "Spends the Quota");
  await expect(page).toHaveURL(appWebHost.paths.conversation);
  await expect(quotaBanner(page)).toBeVisible();

  // The stale tab is not blocked on screen, so its Run reaches the server, which refuses it (402).
  await expect(quotaBanner(stale)).toHaveCount(0);
  const refused = stale.waitForResponse(
    (response) => response.url().includes("/api/chat/") && response.status() === 402,
  );
  await stale.getByLabel("Message", { exact: true }).fill("Refused by the server");
  await stale.keyboard.press("Enter");
  await refused;

  // No reply was written for the refused Run, and the stale tab learns the Quota is spent.
  await expect(messageRows(stale).filter({ hasText: "That's all." })).toHaveCount(0);
  await expect(quotaBanner(stale)).toBeVisible();
  await stale.close();
});
