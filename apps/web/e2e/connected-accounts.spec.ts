import { expect, type Page, test } from "@playwright/test";

import { type CapturedMail, signInOnForm, waitForMail } from "./helpers";
import { seedUser } from "./seed-user";

const NEW_PASSWORD = "first-password-for-oauth-1";

/** The reset link in a message's plain text, which Better Auth serves and redirects to the page. */
function resetLink(mail: CapturedMail): string {
  const match = /https?:\/\/\S*reset-password\/\S+/.exec(mail.text);
  if (!match) throw new Error(`no reset link in "${mail.subject}"`);
  return match[0];
}

/** The Connected accounts row for a provider, found by its visible label. */
function providerRow(page: Page, label: string) {
  return page
    .getByRole("list", { name: "Connected accounts" })
    .getByRole("listitem")
    .filter({
      hasText: `${label}:`,
    });
}

test("a user with a password and GitHub linked can unlink GitHub, and Google stays unlinked", async ({
  page,
}) => {
  await seedUser(page, { linked: ["github"] });
  await page.goto("/settings/account");

  await expect(providerRow(page, "GitHub").getByText("Linked", { exact: true })).toBeVisible();
  await expect(providerRow(page, "Google").getByText("Not linked", { exact: true })).toBeVisible();

  await providerRow(page, "GitHub").getByRole("button", { name: "Unlink GitHub" }).click();
  await expect(page.getByText("Account unlinked")).toBeVisible();
  await expect(providerRow(page, "GitHub").getByText("Not linked", { exact: true })).toBeVisible();
});

test("a user whose only sign-in method is GitHub cannot unlink it, and is told why", async ({
  page,
}) => {
  await seedUser(page, { password: false, linked: ["github"] });
  await page.goto("/settings/account");

  await expect(providerRow(page, "GitHub").getByText("Linked", { exact: true })).toBeVisible();
  await expect(
    providerRow(page, "GitHub").getByRole("button", { name: "Unlink GitHub" }),
  ).toBeDisabled();
  await expect(page.getByText("This is your only way to sign in", { exact: false })).toBeVisible();
});

test('"Link Google" starts the Google flow at its authorize URL with the configured callback', async ({
  page,
}) => {
  await seedUser(page, { linked: ["github"] });
  await page.goto("/settings/account");

  const authorize = "https://accounts.google.com/o/oauth2/v2/auth";
  // Stub the provider so the navigation is caught and never reaches the real host.
  await page.route(`${new URL(authorize).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
  );
  const request = page.waitForRequest((r) => r.url().startsWith(authorize));
  await providerRow(page, "Google").getByRole("button", { name: "Link Google" }).click();
  const url = new URL((await request).url());

  expect(url.searchParams.get("redirect_uri")).toBe(
    `${new URL(page.url()).origin}/api/auth/callback/google`,
  );
});

test("an OAuth-only user sets a first password from the reset link, then signs in with email", async ({
  page,
}) => {
  const seeded = await seedUser(page, { password: false, linked: ["github"] });
  await page.goto("/settings/account");

  await page.getByRole("button", { name: "Email me a link to set a password" }).click();
  await expect(page.getByText("We sent a link to set a password")).toBeVisible();

  const [mail] = await waitForMail(page, seeded.email);
  expect(mail).toMatchObject({ template: "reset-password" });
  await page.goto(resetLink(mail));

  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();

  // The reset signed this device out too, so the new password is the way back in.
  const signIn = await signInOnForm(page, seeded.email, NEW_PASSWORD);
  expect(signIn.status()).toBe(200);
  await expect(page).toHaveURL(/\/c$/);
});
