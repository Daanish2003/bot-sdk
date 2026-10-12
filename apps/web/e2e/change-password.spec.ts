import { expect, type Page, test } from "@playwright/test";

import {
  mailboxFor,
  signInAsSeededUser,
  signInOnForm,
  submitAuthForm,
  waitForMail,
} from "./helpers";
import { seedSession, seedUser } from "./seed-user";

const NEW_PASSWORD = "brand-new-password-1";

// The tests in this file change passwords and sign in a lot; the helpers back off on 429s.
test.describe.configure({ mode: "serial" });

/** Signs out through the user menu, which lands on the login page. */
async function signOut(page: Page) {
  await page.getByRole("button", { name: "E2E User" }).click();
  await page.getByRole("menuitem", { name: "Sign Out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Fills the Account page's password form and submits it. */
async function changePassword(
  page: Page,
  current: string,
  next: string,
  options: { signOutOthers?: boolean } = {},
) {
  await page.goto("/settings/account");
  await page.getByLabel("Current password").fill(current);
  await page.getByLabel("New password").fill(next);
  if (options.signOutOthers) {
    await page.getByRole("checkbox", { name: "Sign out my other sessions" }).click();
  }
  await submitAuthForm(
    page,
    page.getByRole("button", { name: "Change password" }),
    "/api/auth/change-password",
  );
}

/** Signs in from the login page with the email and password given. */
async function signIn(page: Page, email: string, password: string) {
  await signInOnForm(page, email, password);
}

test("changing the password signs in with the new one, and mails a notice", async ({ page }) => {
  const seeded = await signInAsSeededUser(page);
  await changePassword(page, seeded.password, NEW_PASSWORD);
  await expect(page.getByText("Password changed")).toBeVisible();

  await signOut(page);

  await signIn(page, seeded.email, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/c$/);

  const mails = await waitForMail(page, seeded.email);
  expect(mails.map((mail) => mail.template)).toContain("password-changed");
});

test("a wrong current password is refused, and the old password still works", async ({ page }) => {
  const seeded = await signInAsSeededUser(page);
  await changePassword(page, "not-the-password-1", NEW_PASSWORD);
  await expect(page.getByRole("alert")).toHaveText("Current password is incorrect");

  await signOut(page);
  await signIn(page, seeded.email, seeded.password);
  await expect(page).toHaveURL(/\/c$/);

  const mails = await mailboxFor(page, seeded.email);
  expect(mails.map((mail) => mail.template)).not.toContain("password-changed");
});

test("signing out other sessions signs a second device out", async ({ page, browser }) => {
  const seeded = await signInAsSeededUser(page);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await seedSession(otherPage, seeded.id);
    await otherPage.goto("/c");
    await expect(otherPage).toHaveURL(/\/c$/);

    await changePassword(page, seeded.password, NEW_PASSWORD, { signOutOthers: true });
    await expect(page.getByText("Password changed")).toBeVisible();

    await otherPage.goto("/c");
    await expect(otherPage).toHaveURL(/\/login$/);
    await page.goto("/c");
    await expect(page).toHaveURL(/\/c$/);
  } finally {
    await other.close();
  }
});

test("without signing out other sessions, a second device stays signed in", async ({
  page,
  browser,
}) => {
  const seeded = await signInAsSeededUser(page);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await seedSession(otherPage, seeded.id);
    await otherPage.goto("/c");
    await expect(otherPage).toHaveURL(/\/c$/);

    await changePassword(page, seeded.password, NEW_PASSWORD);
    await expect(page.getByText("Password changed")).toBeVisible();

    await otherPage.goto("/c");
    await expect(otherPage).toHaveURL(/\/c$/);
  } finally {
    await other.close();
  }
});

test("a user who signed up with GitHub or Google is not offered a password change", async ({
  page,
}) => {
  await seedUser(page, { password: false });
  await page.goto("/settings/account");

  await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change password" })).toHaveCount(0);
});
