import { createDb } from "@ai-chat/db";
import { expect, type Page, test } from "@playwright/test";

import { randomBytes } from "node:crypto";

import { conversation, message } from "../../../packages/bot-sdk/core/server/db/schema/chat";
import { sharedLink } from "../../../packages/bot-sdk/core/server/db/schema/share";
import { usage } from "../../../packages/bot-sdk/core/server/db/schema/usage";
import { uuidv7 } from "../../../packages/bot-sdk/core/server/lib/uuidv7";
import { storedParts } from "../../../packages/bot-sdk/core/shared/message-parts";

import { e2eDatabaseUrl } from "./database";
import { appWebHost } from "./host";
import { signInOnForm, waitForMail } from "./helpers";
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
  const atQuota = await seedUser(page);
  await spend(atQuota.id, 1_000_000);
  const quiet = await seedUser(page);
  // seedUser signs `page` in as the user it seeds, so the Admin is seeded last.
  const admin = await seedUser(page);
  await makeAdmin(admin);

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
  // The router JSON-encodes the value, so it reads atQuota=%221%22.
  await expect(page).toHaveURL(/atQuota=/);
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

test("an Admin turns off a user's lost two-factor sign-in: sessions end, the password alone signs in, and the notice arrives", async ({
  page,
  browser,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  const target = await seedUser(targetPage, { twoFactor: true });
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();

  await page.goto("/admin");
  const targetRow = page.getByRole("row").filter({ has: emailCell(page, target.email) });
  await expect(targetRow.getByRole("button", { name: "Turn off 2FA", exact: true })).toHaveCount(0);

  // The control lives on the user's detail page.
  await page.goto(`/admin/${target.id}`);
  await page.getByRole("button", { name: "Turn off 2FA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel(/^Reason/)
    .fill("Lost authenticator and backup codes, confirmed by email reply");
  await dialog.getByRole("button", { name: "Turn off 2FA", exact: true }).click();
  await expect(page.getByText("Two-factor sign-in turned off", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off 2FA", exact: true })).toHaveCount(0);

  // The sessions ended: the open tab is signed out.
  await targetPage.goto("/c");
  await expect(targetPage).toHaveURL(/\/login/);

  // The password alone signs in: no second-factor screen.
  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous).toHaveURL(/\/c$/);

  const mail = await waitForMail(page, target.email, 1);
  expect(mail.map((message) => message.template)).toContain("two-factor-disabled");

  await anonymousContext.close();
  await targetContext.close();
});

/**
 * Writes a Conversation of `owner`'s with a question and `replies` ended assistant replies on
 * `model`, straight into the e2e database. Returns the replies' ids, oldest first.
 */
async function writeReplies(owner: SeededUser, model: string, replies: number): Promise<string[]> {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  const conversationId = uuidv7();
  const question = uuidv7();
  const ids = Array.from({ length: replies }, () => uuidv7());
  const now = new Date();
  try {
    await db
      .insert(conversation)
      .values({ id: conversationId, userId: owner.id, title: "Ratings", model });
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
      ...ids.map((id, index) => ({
        id,
        conversationId,
        parentId: question,
        role: "assistant" as const,
        parts: storedParts([{ type: "text", text: `Reply ${index + 1}` }]),
        searchText: `Reply ${index + 1}`,
        status: "complete" as const,
        model,
        createdAt: new Date(now.getTime() + index + 1),
      })),
    ]);
  } finally {
    await db.$client.end();
  }
  return ids;
}

test("an Admin sees each Model's 👍, 👎 and % 👎 after a user rates its replies", async ({
  page,
  browser,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  // The rater signs in on their own browser context, so the Admin's page keeps the Admin's session.
  const raterContext = await browser.newContext();
  const raterPage = await raterContext.newPage();
  const rater = await seedUser(raterPage);
  // A Model no other test uses, so the row is this test's alone.
  const model = `e2e-rated-${randomBytes(4).toString("hex")}`;
  const [firstUp, secondUp, down] = await writeReplies(rater, model, 3);

  for (const [messageId, rating] of [
    [firstUp, "up"],
    [secondUp, "up"],
    [down, "down"],
  ] as const) {
    const response = await raterPage.request.post(`${appWebHost.paths.chatApi}/rpc/chat/rate`, {
      data: { json: { messageId, rating } },
    });
    expect(response.ok()).toBe(true);
  }
  await raterContext.close();

  await page.goto("/admin");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: model, exact: true }) });
  await expect(row.getByRole("cell")).toHaveText([model, "2", "1", "33%"]);
});
