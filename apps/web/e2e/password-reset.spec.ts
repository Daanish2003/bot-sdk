import { expect, test } from "@playwright/test";

import { seedSession, seedUser } from "./seed-user";
import { type CapturedMail, signInOnForm, submitAuthForm, waitForMail } from "./helpers";

const NEW_PASSWORD = "brand-new-password-1";

/** The reset link in a message's plain text, which Better Auth serves and redirects to the page. */
function resetLink(mail: CapturedMail): string {
  const match = /https?:\/\/\S*reset-password\/\S+/.exec(mail.text);
  if (!match) throw new Error(`no reset link in "${mail.subject}"`);
  return match[0];
}

test("a reset link sets a new password, signs out the other device, and a used link is refused", async ({
  page,
  browser,
}) => {
  // A second device, signed in as the same user before the reset.
  const seeded = await seedUser(page);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await seedSession(other, seeded.id);
  await other.goto("/c");
  await expect(other).toHaveURL(/\/c$/);

  // Signed out, so /login shows the form instead of redirecting to the Conversation page.
  await page.context().clearCookies();

  // The same answer for an address with no account.
  await page.goto("/login");
  await page.getByRole("button", { name: "Already have an account? Sign In" }).click();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Email").fill("nobody-here@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If an account exists for that address")).toBeVisible();

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(seeded.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If an account exists for that address")).toBeVisible();

  const [reset] = await waitForMail(page, seeded.email);
  expect(reset).toMatchObject({ template: "reset-password" });
  const link = resetLink(reset);
  await page.goto(link);

  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();

  // The other device is signed out.
  await other.goto("/c");
  await expect(other).toHaveURL(/\/login$/);
  await otherContext.close();

  // The new password signs in; the old one no longer does.
  await signInOnForm(page, seeded.email, seeded.password);
  await expect(page.getByText("Invalid email or password")).toBeVisible();

  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await submitAuthForm(
    page,
    page.getByRole("button", { name: "Sign In" }),
    "/api/auth/sign-in/email",
  );
  await expect(page).toHaveURL(/\/c$/);

  // The notice arrived by email.
  const mails = await waitForMail(page, seeded.email, 2);
  expect(mails.map((mail) => mail.template)).toContain("password-changed");

  // A used link lands on the request form with a message.
  await page.goto(link);
  await expect(page).toHaveURL(/\/forgot-password\?expired=true$/);
  await expect(page.getByText("was already used")).toBeVisible();
});
