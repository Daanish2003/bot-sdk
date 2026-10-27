import { expect, test } from "@playwright/test";

import { botReply, sendMarker } from "./support/fake-ollama";
import { addFakeOllama, botMessages, createBot, sendToBot } from "./helpers";
import { appWebHost } from "./host";

/** The toast a send refused for the spent Quota shows. */
const quotaRefusal = "You've used this window's Quota";

test("a user with no key of their own uses up the Quota, then adds a key and carries on", async ({
  page,
}) => {
  await appWebHost.signIn(page);
  // No key of their own: the Host's Model is the one the new Bot starts on.
  await createBot(page, "Scout");
  const botUrl = page.url();

  await sendToBot(page, `${sendMarker} First question, on the Host's Model`);
  await expect(botMessages(page).last()).toHaveText(botReply);

  // That Turn spent the whole Quota: the next send is refused, with the reason, and its text stays
  // in the composer.
  await sendToBot(page, "Second question, still on the Host's Model");
  await expect(page.getByText(quotaRefusal)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Second question, still on the Host's Model",
  );

  await addFakeOllama(page);

  // The own key runs the same Model, unmetered: the send goes through and the Bot replies.
  await page.goto(botUrl);
  await sendToBot(page, `${sendMarker} Third question, on the user's own key`);
  await expect(botMessages(page).last()).toHaveText(botReply);
  await expect(botMessages(page).filter({ hasText: "Third question" })).toHaveCount(1);
});

test("the server refuses a Host Turn past the Quota, even from a tab that hasn't seen it spent", async ({
  page,
}) => {
  await appWebHost.signIn(page);
  await createBot(page, "Scout");

  // A second tab, loaded before the Quota is spent.
  const stale = await page.context().newPage();
  await stale.goto(page.url());
  await expect(stale.getByRole("heading", { name: "Scout" })).toBeVisible();

  await sendToBot(page, `${sendMarker} Spends the Quota`);
  await expect(botMessages(page).last()).toHaveText(botReply);

  // The stale tab's send reaches the server, which refuses it (402).
  const refused = stale.waitForResponse(
    (response) => response.url().includes("/api/chat/") && response.status() === 402,
  );
  await sendToBot(stale, "Refused by the server");
  await refused;

  // The Message was not saved: its bubble goes, and its text comes back to the composer.
  await expect(stale.getByText(quotaRefusal)).toBeVisible();
  await expect(stale.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Refused by the server",
  );
  await expect(botMessages(stale).filter({ hasText: "Refused by the server" })).toHaveCount(0);
  await stale.close();
});
