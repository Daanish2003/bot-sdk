import { expect, test } from "@playwright/test";

import { seedSession } from "./seed-user";
import { signInAsSeededUser } from "./helpers";

test("the user menu links to the Account page", async ({ page }) => {
  await signInAsSeededUser(page);
  await page.getByRole("button", { name: "E2E User" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();

  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
});

test("a changed name shows in the user menu after reload", async ({ page }) => {
  await signInAsSeededUser(page);
  await page.goto("/settings/account");
  await page.getByLabel("Name").fill("Renamed Person");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name updated")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Renamed Person" })).toBeVisible();
});

test("sessions list the current device, and sign out the other sessions", async ({
  page,
  browser,
}) => {
  const seeded = await signInAsSeededUser(page);
  // The list is fetched after the page loads: wait for that fetch, not for a fixed time.
  const listed = () =>
    page.waitForResponse((r) => r.url().includes("/api/auth/list-sessions") && r.ok());
  const firstList = listed();
  await page.goto("/settings/account");
  await firstList;
  const sessions = page.getByRole("list", { name: "Active sessions" }).getByRole("listitem");
  await expect(sessions).toHaveCount(1);
  await expect(sessions.first()).toContainText("This device");

  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await seedSession(otherPage, seeded.id);
    const reloaded = listed();
    await page.reload();
    await reloaded;
    await expect(sessions).toHaveCount(2);
    await expect(sessions.filter({ hasText: "This device" })).toHaveCount(1);

    const afterSignOut = listed();
    await page.getByRole("button", { name: "Sign out other sessions" }).click();
    await afterSignOut;
    await expect(sessions).toHaveCount(1);

    const finalReload = listed();
    await page.reload();
    await finalReload;
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(sessions).toHaveCount(1);

    await otherPage.goto("/settings/account");
    await expect(otherPage).toHaveURL(/\/login$/);
  } finally {
    await other.close();
  }
});

test("a signed-out visitor is sent to the login page from the Account page", async ({ page }) => {
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/login$/);
});
