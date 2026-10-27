import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { botReply, sendMarker } from "./support/fake-ollama";
import {
  type CapturedMail,
  addFakeOllama,
  botMessages,
  createBot,
  sendToBot,
  verificationLink,
  waitForMail,
} from "./helpers";
import { e2eDatabaseUrl } from "./database.ts";
import { seedUser } from "./seed-user";

/** The account-deletion link in a message's plain text. */
function deletionLink(mail: CapturedMail): string {
  const match = /https?:\/\/\S*delete-user\/callback\?token=\S+/.exec(mail.text);
  if (!match) throw new Error(`no deletion link in "${mail.subject}"`);
  return match[0];
}

/** How many rows the e2e database holds for a user, in a Bot SDK table. */
async function countRows(table: "bot" | "conversation", userId: string): Promise<number> {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    const result = await db.$client.query(
      `select count(*) as count from botsdk.${table} where user_id = $1`,
      [userId],
    );
    return Number(result.rows[0].count);
  } finally {
    await db.$client.end();
  }
}

test("deleting the account removes its Bots and their Conversations, and the email can sign up again", async ({
  page,
}) => {
  const seeded = await seedUser(page);
  await addFakeOllama(page);
  await createBot(page, "Something to delete");
  await sendToBot(page, `${sendMarker} Say hello`);
  await expect(botMessages(page).last()).toHaveText(botReply);
  expect(await countRows("bot", seeded.id)).toBe(1);
  expect(await countRows("conversation", seeded.id)).toBe(1);

  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText(`We sent a confirmation link to ${seeded.email}`)).toBeVisible();

  // The confirmation link, from the capture mailbox, deletes the account at once.
  const [confirm] = await waitForMail(page, seeded.email);
  expect(confirm).toMatchObject({ template: "delete-account-confirm" });
  await page.goto(deletionLink(confirm));
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/login$/);

  // The Bot SDK's rows went with the account.
  expect(await countRows("bot", seeded.id)).toBe(0);
  expect(await countRows("conversation", seeded.id)).toBe(0);

  const notice = await waitForMail(page, seeded.email, 2);
  expect(notice.map((message) => message.template)).toContain("account-deleted");

  // The same address signs up again, and verifies through the mailbox.
  await page.goto("/login");
  await page.getByLabel("Name").fill("Returning User");
  await page.getByLabel("Email").fill(seeded.email);
  await page.getByLabel("Password").fill("returning-password-1");
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const messages = await waitForMail(page, seeded.email, 3);
  const verify = messages.at(-1)!;
  expect(verify).toMatchObject({ template: "verify-email" });
  await page.goto(verificationLink(verify));
  // Verifying signs the user in (autoSignInAfterVerification), then the page offers the chat.
  await expect(page.getByRole("button", { name: "Continue to Bots" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to Bots" }).click();
  await expect(page).toHaveURL(/\/bots$/);
});
