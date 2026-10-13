import { createDb } from "@ai-chat/db";
import { expect, type Page, test } from "@playwright/test";

import { randomBytes } from "node:crypto";

import { conversation, message } from "../../../packages/chat-sdk/core/server/db/schema/chat";
import { sharedLink } from "../../../packages/chat-sdk/core/server/db/schema/share";
import { usage } from "../../../packages/chat-sdk/core/server/db/schema/usage";
import { uuidv7 } from "../../../packages/chat-sdk/core/server/lib/uuidv7";
import { storedParts } from "../../../packages/chat-sdk/core/shared/message-parts";

import { e2eDatabaseUrl } from "./database";
import { signInOnForm } from "./helpers";
import { type SeededUser, seedUser } from "./seed-user";

/** Makes a signed-in user an Admin, straight in the e2e database (the grant script's effect). */
async function makeAdmin(seeded: SeededUser) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(`update "user" set role = 'admin' where id = $1`, [seeded.id]);
  } finally {
    await db.$client.end();
  }
}

/** Spends `costMicros` on the Host today, so the user's window reads that spend. */
async function spend(userId: string, costMicros: number) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.insert(usage).values({
      id: uuidv7(),
      userId,
      kind: "run",
      model: "e2e-model",
      inputTokens: 0,
      outputTokens: 0,
      costMicros,
      estimated: false,
      createdAt: new Date(),
    });
  } finally {
    await db.$client.end();
  }
}

const emailCell = (page: Page, email: string) =>
  page.getByRole("cell", { name: email, exact: true });

test("a user who isn't an Admin gets a 404 on /admin", async ({ page }) => {
  await seedUser(page);

  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Users", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("an Admin sees spend against Quota, searches, sorts and filters to At Quota", async ({
  page,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const atQuota = await seedUser(page);
  await spend(atQuota.id, 1_000_000);
  const quiet = await seedUser(page);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  const atQuotaRow = page.getByRole("row").filter({ has: emailCell(page, atQuota.email) });
  await expect(atQuotaRow).toContainText("$1.00 of $1.00");
  await expect(atQuotaRow).toContainText("At Quota");

  await page.getByLabel("Search by email").fill(quiet.email);
  await expect(emailCell(page, quiet.email)).toBeVisible();
  await expect(emailCell(page, atQuota.email)).toHaveCount(0);

  await page.getByLabel("Search by email").fill("");
  await page.getByRole("button", { name: "Sort by spend" }).click();
  await expect(page).toHaveURL(/sort=spend/);
  await expect(emailCell(page, atQuota.email)).toBeVisible();

  await page.getByRole("button", { name: "At Quota" }).click();
  await expect(page).toHaveURL(/atQuota=1/);
  await expect(emailCell(page, atQuota.email)).toBeVisible();
  await expect(emailCell(page, quiet.email)).toHaveCount(0);
});

/**
 * Writes a two-message Conversation of `owner`'s and its Shared link straight into the e2e database
 * (a reply's Run is not needed for the link). Returns the link's token.
 */
async function shareConversation(owner: SeededUser, title: string): Promise<string> {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  const conversationId = uuidv7();
  const question = uuidv7();
  const reply = uuidv7();
  const token = randomBytes(16).toString("base64url");
  const now = new Date();
  try {
    await db
      .insert(conversation)
      .values({ id: conversationId, userId: owner.id, title, model: "e2e-model" });
    await db.insert(message).values([
      {
        id: question,
        conversationId,
        role: "user",
        parts: storedParts([{ type: "text", text: "Hello" }]),
        searchText: "Hello",
        status: "complete",
        createdAt: now,
      },
      {
        id: reply,
        conversationId,
        parentId: question,
        role: "assistant",
        parts: storedParts([{ type: "text", text: "Hi there" }]),
        searchText: "Hi there",
        status: "complete",
        model: "e2e-model",
        createdAt: new Date(now.getTime() + 1),
      },
    ]);
    // The Active Branch's leaf is set last: the message rows must exist before it can point at one.
    await db.$client.query(`update chat.conversation set active_leaf_id = $1 where id = $2`, [
      reply,
      conversationId,
    ]);
    await db.insert(sharedLink).values({
      token,
      conversationId,
      leafMessageId: reply,
      title,
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    await db.$client.end();
  }
  return token;
}

test("a Ban signs a user out, blocks sign-in and hides their Shared link; unbanning restores both", async ({
  page,
  browser,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  const target = await seedUser(targetPage);
  const token = await shareConversation(target, "Banned chat");
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();

  await anonymous.goto(`/share/${token}`);
  await expect(anonymous).toHaveTitle("Banned chat · ai-chat");

  await page.goto("/admin");
  const targetRow = page.getByRole("row").filter({ has: emailCell(page, target.email) });
  await targetRow.getByRole("button", { name: "Ban", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Reason/).fill("Spamming the chat");
  await dialog.getByRole("button", { name: "Ban user" }).click();
  await expect(page.getByText("User banned", { exact: true })).toBeVisible();
  await expect(targetRow).toContainText("Banned");

  // The Ban ended the user's sessions: their open tab is signed out.
  await targetPage.goto("/c");
  await expect(targetPage).toHaveURL(/\/login/);

  // Sign-in is refused with the one static message, and the Shared link is not found.
  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous.getByText("This account is suspended.")).toBeVisible();
  await anonymous.goto(`/share/${token}`);
  await expect(anonymous).toHaveTitle("Not found · ai-chat");

  await page.goto("/admin");
  await targetRow.getByRole("button", { name: "Unban", exact: true }).click();
  await expect(targetRow).toContainText("Active");

  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous).not.toHaveURL(/\/login/);
  await anonymous.goto(`/share/${token}`);
  await expect(anonymous).toHaveTitle("Banned chat · ai-chat");

  await anonymousContext.close();
  await targetContext.close();
});

test("an Admin's own row offers no Ban", async ({ page }) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);

  await page.goto("/admin");

  const adminRow = page.getByRole("row").filter({ has: emailCell(page, admin.email) });
  await expect(adminRow).toBeVisible();
  await expect(adminRow.getByRole("button", { name: "Ban", exact: true })).toHaveCount(0);
});

/** The Host's Model in the open Model picker. */
const hostOption = (page: Page) =>
  page.getByRole("group").getByRole("button").filter({ hasText: "e2e-model" });

test("an Admin sets a user's Quota to 0, which turns Host Models off for them, and clearing it restores the default", async ({
  page,
  browser,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  const target = await seedUser(targetPage);

  await page.goto("/admin");
  await page.getByRole("link", { name: target.email, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Quota", exact: true })).toBeVisible();
  await page.getByLabel(/^Budget in dollars/).fill("0");
  await page.getByRole("button", { name: "Set budget", exact: true }).click();
  await expect(page.getByText("Quota saved", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.00: Host Models are off for this user")).toBeVisible();

  await targetPage.goto("/c");
  await expect(targetPage.getByRole("button", { name: "Model" })).toBeVisible();
  await targetPage.getByRole("button", { name: "Model" }).click();
  await expect(hostOption(targetPage)).toBeDisabled();
  await targetPage.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear to default", exact: true }).click();
  await expect(page.getByText("Quota cleared to the default", { exact: true })).toBeVisible();
  await expect(page.getByText("Host default:")).toBeVisible();

  await targetPage.goto("/c");
  await targetPage.getByRole("button", { name: "Model" }).click();
  await expect(hostOption(targetPage)).toBeEnabled();
  await targetContext.close();
});
