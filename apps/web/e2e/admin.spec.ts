import { createDb } from "@ai-chat/db";
import { expect, type Page, test } from "@playwright/test";

import { usage } from "@botsdk/bot/storage/schema";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";

import { e2eDatabaseUrl } from "./database";
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

/** Spends `costMicros` on a Bot Turn on the Host today, so the user's window reads that spend. */
async function spend(userId: string, costMicros: number) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.insert(usage).values({
      id: uuidv7(),
      userId,
      kind: "turn",
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

test("a Ban signs a user out and blocks sign-in; unbanning restores both", async ({
  page,
  browser,
}) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  const target = await seedUser(targetPage);
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();

  await page.goto("/admin");
  const targetRow = page.getByRole("row").filter({ has: emailCell(page, target.email) });
  await targetRow.getByRole("button", { name: "Ban", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Reason/).fill("Spamming the chat");
  await dialog.getByRole("button", { name: "Ban user" }).click();
  await expect(page.getByText("User banned", { exact: true })).toBeVisible();
  await expect(targetRow).toContainText("Banned");

  // The Ban ended the user's sessions: their open tab is signed out.
  await targetPage.goto("/bots");
  await expect(targetPage).toHaveURL(/\/login/);

  // Sign-in is refused with the one static message.
  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous.getByText("This account is suspended.")).toBeVisible();

  await page.goto("/admin");
  await targetRow.getByRole("button", { name: "Unban", exact: true }).click();
  await expect(targetRow).toContainText("Active");

  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous).toHaveURL(/\/bots$/);

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

/** Opens the New Bot dialog's Model picker. */
async function openModelPicker(page: Page) {
  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("button", { name: "Model" }).click();
}

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

  await openModelPicker(targetPage);
  await expect(hostOption(targetPage)).toBeDisabled();
  await targetPage.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear to default", exact: true }).click();
  await expect(page.getByText("Quota cleared to the default", { exact: true })).toBeVisible();
  await expect(page.getByText("Host default:")).toBeVisible();

  await openModelPicker(targetPage);
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
  await targetPage.goto("/bots");
  await expect(targetPage).toHaveURL(/\/login/);

  // The password alone signs in: no second-factor screen.
  await signInOnForm(anonymous, target.email, target.password);
  await expect(anonymous).toHaveURL(/\/bots$/);

  const mail = await waitForMail(page, target.email, 1);
  expect(mail.map((message) => message.template)).toContain("two-factor-disabled");

  await anonymousContext.close();
  await targetContext.close();
});

test("Settings and Admin are reachable from the Bots shell", async ({ page }) => {
  const admin = await seedUser(page);
  await makeAdmin(admin);
  await page.goto("/bots");
  const sidebar = page.getByRole("complementary", { name: "Bots" });

  await sidebar.getByRole("button", { name: admin.name }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole("button", { name: admin.name }).click();
  await page.getByRole("menuitem", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ratings" })).toHaveCount(0);
  await expect(sidebar).toBeVisible();
});

test("the account menu offers no Admin to a user who isn't one", async ({ page }) => {
  const user = await seedUser(page);
  await page.goto("/bots");
  await page
    .getByRole("complementary", { name: "Bots" })
    .getByRole("button", { name: user.name })
    .click();
  await expect(page.getByRole("menuitem", { name: "Keys" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
});
