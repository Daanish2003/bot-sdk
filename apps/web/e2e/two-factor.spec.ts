import { expect, type Page, test } from "@playwright/test";

import { signInAsSeededUser, signInOnForm, submitAuthForm, waitForMail } from "./helpers";
import { seedSession, seedUser } from "./seed-user";
import { base32Key, totpCode } from "./totp";

const ACCOUNT = "/settings/account";
// Every two-factor call shares one rate limit (3 per 10 seconds per IP), so each click waits it out.
const API = "/api/auth/two-factor";

/** Turns two-factor sign-in on from the Account page, confirming the first code. */
async function enableOnAccountPage(
  page: Page,
  password: string,
): Promise<{ key: Buffer; backupCodes: string[] }> {
  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
  await page.locator("#two-factor-enable-password").fill(password);
  await submitAuthForm(page, page.getByRole("button", { name: "Continue" }), `${API}/enable`);

  const setupKey = await page.locator("p", { hasText: "Setup key:" }).locator("code").textContent();
  const key = base32Key(setupKey ?? "");
  await page.getByLabel("Authentication code").fill(totpCode(key));
  await submitAuthForm(page, page.getByRole("button", { name: "Confirm" }), `${API}/verify-totp`);

  const backupCodes = await page
    .getByRole("list", { name: "Backup codes" })
    .getByRole("listitem")
    .allTextContents();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Signing in asks for a code")).toBeVisible();
  return { key, backupCodes };
}

test("enable through the UI, sign in with a code, sign in with a backup code once, trust a device, turn off", async ({
  page,
  browser,
}) => {
  const seeded = await signInAsSeededUser(page);
  const { key, backupCodes } = await enableOnAccountPage(page, seeded.password);
  expect(backupCodes).toHaveLength(10);

  // A new browser context signs in with a password, then the second factor.
  const device = await browser.newContext();
  try {
    const login = await device.newPage();
    await signInOnForm(login, seeded.email, seeded.password);
    await expect(login).toHaveURL(/\/two-factor$/);
    await login.getByLabel("Authentication code").fill(totpCode(key));
    await submitAuthForm(
      login,
      login.getByRole("button", { name: "Verify" }),
      `${API}/verify-totp`,
    );
    await expect(login).toHaveURL(/\/c$/);

    // Backup code: works once, and the same code is refused the second time.
    await device.clearCookies();
    const backup = await device.newPage();
    await signInOnForm(backup, seeded.email, seeded.password);
    await expect(backup).toHaveURL(/\/two-factor$/);
    await backup.getByRole("button", { name: "Use a backup code instead" }).click();
    await backup.getByLabel("Backup code").fill(backupCodes[0]!);
    await submitAuthForm(
      backup,
      backup.getByRole("button", { name: "Verify" }),
      `${API}/verify-backup-code`,
    );
    await expect(backup).toHaveURL(/\/c$/);

    await device.clearCookies();
    const reused = await device.newPage();
    await signInOnForm(reused, seeded.email, seeded.password);
    await expect(reused).toHaveURL(/\/two-factor$/);
    await reused.getByRole("button", { name: "Use a backup code instead" }).click();
    await reused.getByLabel("Backup code").fill(backupCodes[0]!);
    await submitAuthForm(
      reused,
      reused.getByRole("button", { name: "Verify" }),
      `${API}/verify-backup-code`,
    );
    await expect(reused.getByText("Invalid backup code")).toBeVisible();
    await expect(reused).toHaveURL(/\/two-factor$/);

    // A trusted device skips the code on its next sign-in.
    await device.clearCookies();
    const trusted = await device.newPage();
    await signInOnForm(trusted, seeded.email, seeded.password);
    await expect(trusted).toHaveURL(/\/two-factor$/);
    await trusted.getByLabel("Authentication code").fill(totpCode(key));
    await trusted.getByRole("checkbox", { name: "Trust this device for 30 days" }).check();
    await submitAuthForm(
      trusted,
      trusted.getByRole("button", { name: "Verify" }),
      `${API}/verify-totp`,
    );
    await expect(trusted).toHaveURL(/\/c$/);

    await device.clearCookies({ name: "better-auth.session_token" });
    const again = await device.newPage();
    await signInOnForm(again, seeded.email, seeded.password);
    await expect(again).toHaveURL(/\/c$/);
  } finally {
    await device.close();
  }

  // Turning off asks for the password and sends the notice.
  await page.goto(ACCOUNT);
  await page.locator("#two-factor-disable-password").fill(seeded.password);
  await submitAuthForm(page, page.getByRole("button", { name: "Turn off" }), `${API}/disable`);
  await expect(
    page.getByRole("button", { name: "Turn on two-factor authentication" }),
  ).toBeVisible();

  const mail = await waitForMail(page, seeded.email, 2);
  expect(mail.map((message) => message.template)).toEqual(
    expect.arrayContaining(["two-factor-enabled", "two-factor-disabled"]),
  );
});

test("turning two-factor on signs out another session", async ({ page, browser }) => {
  const seeded = await signInAsSeededUser(page);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await seedSession(otherPage, seeded.id);
    await otherPage.goto(ACCOUNT);
    await expect(otherPage.getByRole("heading", { name: "Account", exact: true })).toBeVisible();

    await enableOnAccountPage(page, seeded.password);

    await otherPage.goto(ACCOUNT);
    await expect(otherPage).toHaveURL(/\/login$/);
  } finally {
    await other.close();
  }
});

test("an OAuth-only user sees the explanation, not the enable button", async ({ page }) => {
  await seedUser(page, { password: false, linked: ["github"] });
  await page.goto(ACCOUNT);

  await expect(
    page.getByText("You sign in with GitHub or Google, which secures your sign-in"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on two-factor authentication" })).toHaveCount(
    0,
  );
});

test("a seeded two-factor user is asked for a code at sign-in", async ({ page, browser }) => {
  const seeded = await seedUser(page, { twoFactor: true });
  const device = await browser.newContext();
  try {
    const login = await device.newPage();
    await signInOnForm(login, seeded.email, seeded.password);
    await expect(login).toHaveURL(/\/two-factor$/);
    await login.getByLabel("Authentication code").fill(totpCode(Buffer.from(seeded.totpSecret!)));
    await submitAuthForm(
      login,
      login.getByRole("button", { name: "Verify" }),
      `${API}/verify-totp`,
    );
    await expect(login).toHaveURL(/\/c$/);
  } finally {
    await device.close();
  }
});
