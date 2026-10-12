import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { baseURL } from "./env";
import { mailboxFor, signInOnForm, verificationLink, waitForMail } from "./helpers";
import { seedUser } from "./seed-user";

test("a change of email is confirmed from the current address, then verified at the new one", async ({
  page,
}) => {
  const seeded = await seedUser(page);
  const newEmail = `e2e-new-${randomUUID()}@example.com`;

  await page.goto("/settings/account");
  await page.getByLabel("New email").fill(newEmail);
  await page.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText("We sent a confirmation to your current address")).toBeVisible();

  // The confirmation goes to the current address, and nothing reaches the new one yet.
  const [confirm] = await waitForMail(page, seeded.email);
  expect(confirm).toMatchObject({ template: "change-email-confirm" });
  expect(await mailboxFor(page, newEmail)).toHaveLength(0);

  await page.goto(verificationLink(confirm));
  await expect(page.getByRole("heading", { name: "Email change" })).toBeVisible();

  const [verify] = await waitForMail(page, newEmail);
  expect(verify).toMatchObject({ template: "verify-new-email" });
  await page.goto(verificationLink(verify));
  await expect(page.getByText(`Your account email is ${newEmail}`)).toBeVisible();

  await page.goto("/settings/account");
  await expect(page.getByText(`Current address: ${newEmail}`)).toBeVisible();
  await page.getByRole("button", { name: seeded.name }).click();
  await expect(page.getByRole("menuitem", { name: newEmail })).toBeVisible();

  // The new address signs in, and the old one no longer does.
  await page.getByRole("menuitem", { name: "Sign Out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signInOnForm(page, seeded.email, seeded.password);
  await expect(page.getByText("Invalid email or password")).toBeVisible();

  await signInOnForm(page, newEmail, seeded.password);
  await expect(page).toHaveURL(/\/c$/);
});

test("an invalid email change link shows an error page", async ({ page }) => {
  const returnTo = encodeURIComponent(`${baseURL}/email-changed`);
  await page.goto(
    `${baseURL}/api/auth/verify-email?token=not-a-real-token&callbackURL=${returnTo}`,
  );

  await expect(page).toHaveURL(/\/email-changed\?error=/);
  await expect(
    page.getByRole("heading", { name: "This link did not change your email" }),
  ).toBeVisible();
});
