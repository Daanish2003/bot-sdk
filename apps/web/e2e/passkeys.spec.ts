import { createDb, eq } from "@ai-chat/db";
import { session } from "@ai-chat/db/schema/auth";
import { expect, type Page, test } from "@playwright/test";

import { baseURL } from "./env";
import { e2eDatabaseUrl } from "./database.ts";
import { mailboxFor, signInAsSeededUser, waitForMail } from "./helpers";
import { seedUser } from "./seed-user";

const ACCOUNT = "/settings/account";

// Passkey sign-in allows 3 requests per 10 seconds per IP and path, and every test here shares the
// IP. So the tests run in order (the rate-limit test last), and each passkey sign-in waits out the
// window the one before it used.
test.describe.configure({ mode: "serial" });
const PASSKEY_WINDOW_MS = 10_000;
let lastPasskeySignIn = 0;

/** A virtual CTAP2 authenticator on the page's browser: it answers passkey prompts. */
async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
}

/** Ages every session of `userId` by two days, past the one-day window for adding a passkey. */
async function ageSessions(userId: string) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(session.userId, userId));
  } finally {
    await db.$client.end();
  }
}

test("add a passkey, sign out, sign in with it, rename, delete; the notice arrives and delete sends nothing", async ({
  page,
}) => {
  const seeded = await signInAsSeededUser(page);
  await addVirtualAuthenticator(page);

  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Add passkey" }).click();
  // The browser prompt is answered by the virtual authenticator; then the new passkey is named.
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Save passkey name" }).click();
  await expect(page.getByText("Laptop", { exact: true })).toBeVisible();

  // The "passkey added" notice reaches the test mailbox.
  const mail = await waitForMail(page, seeded.email, 1);
  expect(mail.map((message) => message.template)).toContain("passkey-added");

  // Sign out, then sign in with the passkey alone: no password, and no second-factor prompt.
  // A POST needs a body (`data`) to send its JSON content type; without one the server answers 415.
  await page.request.post("/api/auth/sign-out", { headers: { origin: baseURL }, data: {} });
  await signInWithPasskey(page);
  await expect(page).toHaveURL(/\/bots$/);

  // Rename it.
  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Rename Laptop" }).click();
  await page.getByLabel("Passkey name").fill("Work laptop");
  await page.getByRole("button", { name: "Save passkey name" }).click();
  await expect(page.getByText("Work laptop", { exact: true })).toBeVisible();

  // Delete it. Removing a passkey sends no notice, so the mailbox still holds the one message.
  await page.getByRole("button", { name: "Delete Work laptop" }).click();
  await expect(page.getByText("Work laptop", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(await mailboxFor(page, seeded.email)).toHaveLength(1);
});

test("a session older than a day is asked to sign in again before a passkey is added", async ({
  page,
}) => {
  const seeded = await signInAsSeededUser(page);
  await addVirtualAuthenticator(page);
  await ageSessions(seeded.id);

  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Add passkey" }).click();

  await expect(page.getByText("Sign in again to add a passkey.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByLabel("Passkey name")).toHaveCount(0);
});

/** Makes a user an Admin, straight in the e2e database (the grant script's effect). */
async function makeAdmin(userId: string) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(`update "user" set role = 'admin' where id = $1`, [userId]);
  } finally {
    await db.$client.end();
  }
}

/** On the Account page, adds a passkey through the virtual authenticator and names it. */
async function addPasskeyOnAccount(page: Page, name: string) {
  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Add passkey" }).click();
  await page.getByLabel("Passkey name").fill(name);
  await page.getByRole("button", { name: "Save passkey name" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/** Signs in from the login page with the passkey on the page's authenticator, after the window. */
async function signInWithPasskey(page: Page) {
  const wait = lastPasskeySignIn + PASSKEY_WINDOW_MS - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await page.goto("/login");
  await page.getByRole("button", { name: "Already have an account? Sign In" }).click();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  lastPasskeySignIn = Date.now();
}

test("a banned user with a passkey can't sign in with it", async ({ page, browser }) => {
  const admin = await seedUser(page);
  await makeAdmin(admin.id);

  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  const seeded = await seedUser(target);
  await addVirtualAuthenticator(target);
  await addPasskeyOnAccount(target, "Laptop");

  // The Ban is made the way admin.spec.ts makes it: from the Admin view.
  await page.goto("/admin");
  const row = page.getByRole("row").filter({ has: page.getByText(seeded.email, { exact: true }) });
  await row.getByRole("button", { name: "Ban", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Reason/).fill("Spamming the chat");
  await dialog.getByRole("button", { name: "Ban user" }).click();
  await expect(page.getByText("User banned", { exact: true })).toBeVisible();

  // No cookies: a fresh sign-in attempt with the passkey is refused, and no session is made.
  await targetContext.clearCookies();
  await signInWithPasskey(target);
  await expect(target.getByText("This account is suspended.")).toBeVisible();
  await target.goto("/bots");
  await expect(target).toHaveURL(/\/login/);
});

test("a passkey sign-in skips the two-factor prompt for a user with two-factor on", async ({
  page,
}) => {
  await seedUser(page, { twoFactor: true });
  await addVirtualAuthenticator(page);
  await addPasskeyOnAccount(page, "Laptop");

  await page.context().clearCookies();
  await signInWithPasskey(page);

  await expect(page).toHaveURL(/\/bots$/);
  await expect(page.getByLabel("Authentication code")).toHaveCount(0);
});

test("passkey sign-in is rate-limited like password sign-in", async ({ page }) => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await page.request.post("/api/auth/passkey/verify-authentication", {
      headers: { origin: baseURL },
      data: { response: { id: `unknown-${attempt}` } },
    });
    statuses.push(response.status());
  }
  expect(statuses[3]).toBe(429);
});
