import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { appWebHost } from "./host";
import { type CapturedMail, addFakeOllama, send, verificationLink, waitForMail } from "./helpers";
import { e2eDatabaseUrl } from "./database.ts";
import { seedUser } from "./seed-user";

/** The account-deletion link in a message's plain text. */
function deletionLink(mail: CapturedMail): string {
  const match = /https?:\/\/\S*delete-user\/callback\?token=\S+/.exec(mail.text);
  if (!match) throw new Error(`no deletion link in "${mail.subject}"`);
  return match[0];
}

/** How many rows the e2e database holds for a Conversation id, in a Chat SDK table. */
async function countRows(table: "conversation" | "shared_link", id: string): Promise<number> {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  const column = table === "conversation" ? "id" : "conversation_id";
  try {
    const result = await db.$client.query(
      `select count(*) as count from chat.${table} where ${column} = $1`,
      [id],
    );
    return Number(result.rows[0].count);
  } finally {
    await db.$client.end();
  }
}

test("deleting the account removes its Conversation and Shared link, and the email can sign up again", async ({
  page,
  browser,
}) => {
  const seeded = await seedUser(page);
  await addFakeOllama(page);
  await page.goto("/c");
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  await send(page, "Something to delete");
  await expect(page).toHaveURL(appWebHost.paths.conversation);
  const conversationId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create link" }).click();
  const sharedUrl = (await dialog.getByText(appWebHost.paths.sharedLink).textContent()) ?? "";
  const visitor = await browser.newPage();
  await visitor.goto(sharedUrl);
  await expect(visitor.getByText("Something to delete").first()).toBeVisible();
  await page.keyboard.press("Escape");

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

  // The Chat SDK's rows went with the account, and the Shared link no longer opens.
  expect(await countRows("conversation", conversationId)).toBe(0);
  expect(await countRows("shared_link", conversationId)).toBe(0);
  await visitor.goto(sharedUrl);
  await expect(visitor.getByText("Shared link not found")).toBeVisible();

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
  await expect(page.getByRole("button", { name: "Continue to chat" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to chat" }).click();
  await expect(page).toHaveURL(/\/c$/);
});
