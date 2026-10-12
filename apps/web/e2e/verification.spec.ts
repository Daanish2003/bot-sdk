import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { verificationLink, waitForMail } from "./helpers";

const PASSWORD = "password1234";

function newEmail() {
  return `e2e-${randomUUID()}@example.com`;
}

/** Fills the sign-up form and submits it. */
async function signUpThroughForm(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
}

test("sign-up says check your email, and the mailbox link signs the user in", async ({ page }) => {
  const email = newEmail();
  await signUpThroughForm(page, email);

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  const [mail] = await waitForMail(page, email);
  expect(mail).toMatchObject({ template: "verify-email" });
  await page.goto(verificationLink(mail));

  await expect(page.getByRole("heading", { name: "Your email is verified" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to chat" }).click();
  await expect(page).toHaveURL(/\/c$/);
});

test("resend on the check your email screen sends a second message", async ({ page }) => {
  const email = newEmail();
  await signUpThroughForm(page, email);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await waitForMail(page, email, 1);

  await page.getByRole("button", { name: "Resend email" }).click();

  await expect(page.getByText("We sent a new link")).toBeVisible();
  await waitForMail(page, email, 2);
});

test("signing in before verifying shows check your email with resend, and sends a fresh link", async ({
  page,
}) => {
  const email = newEmail();
  await signUpThroughForm(page, email);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await waitForMail(page, email, 1);

  await page.goto("/login");
  await page.getByRole("button", { name: "Already have an account? Sign In" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText("We sent you a new link")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend email" })).toBeVisible();
  await waitForMail(page, email, 2);
});
