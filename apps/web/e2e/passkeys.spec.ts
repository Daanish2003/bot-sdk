import { createDb, eq } from "@ai-chat/db";
import { session } from "@ai-chat/db/schema/auth";
import { expect, type Page, test } from "@playwright/test";

import { baseURL } from "./env";
import { e2eDatabaseUrl } from "./database.ts";
import { mailboxFor, signInAsSeededUser, waitForMail } from "./helpers";

const ACCOUNT = "/settings/account";

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
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Laptop", { exact: true })).toBeVisible();

  // The "passkey added" notice reaches the test mailbox.
  const mail = await waitForMail(page, seeded.email, 1);
  expect(mail.map((message) => message.template)).toContain("passkey-added");

  // Sign out, then sign in with the passkey alone: no password, and no second-factor prompt.
  await page.request.post("/api/auth/sign-out", { headers: { origin: baseURL } });
  await page.goto("/login");
  await page.getByRole("button", { name: "Already have an account? Sign In" }).click();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/c$/);

  // Rename it.
  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Rename Laptop" }).click();
  await page.getByLabel("Passkey name").fill("Work laptop");
  await page.getByRole("button", { name: "Save name" }).click();
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
  await expect(page.getByLabel("Passkey name")).toHaveCount(0);
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
