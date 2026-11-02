import { expect, test } from "@playwright/test";

import { createBot, signInAsSeededUser } from "./helpers";

test("an owner creates a Representative, approves a Release, edits the draft and switches it on", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await createBot(page, "Ada");

  await page.goto("/representatives");
  await expect(page.getByText("No Representatives yet.")).toBeVisible();
  await page.getByLabel("Name").fill("Front desk");
  await page.getByLabel("Reports to").selectOption({ label: "Ada" });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Front desk" })).toBeVisible();
  await expect(page.getByText("No Release yet")).toBeVisible();

  // A blank draft can't be approved.
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Write the job text before approving").first()).toBeVisible();

  await page.getByLabel("Job text").fill("Answer questions about opening hours.");
  await page.getByRole("checkbox", { name: "Hand off to the Bot" }).click();
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
  await expect(page.locator('[data-release="1"]')).toContainText("Live");

  // Editing the draft leaves the live Release alone.
  await page.getByLabel("Job text").fill("Answer anything.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved").first()).toBeVisible();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
  await page.getByRole("checkbox", { name: "Serving" }).click();
  await expect(page.getByRole("checkbox", { name: "Serving" })).toBeChecked();

  // It all holds after a reload.
  await page.reload();
  await expect(page.getByLabel("Job text")).toHaveValue("Answer anything.");
  await expect(page.getByRole("checkbox", { name: "Hand off to the Bot" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Serving" })).toBeChecked();
  await expect(page.getByText("Live: Release 1")).toBeVisible();

  await page.goto("/representatives");
  const row = page.getByRole("listitem").filter({ hasText: "Front desk" });
  await expect(row).toContainText("Reports to: Ada");
  await expect(row).toContainText("Live: Release 1");
  await expect(row).toContainText("On");
});

test("an owner can't open another owner's Representative", async ({ page, browser }) => {
  await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Private");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const { pathname } = new URL(page.url());

  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await signInAsSeededUser(other);
    await other.goto(pathname);
    await other.waitForLoadState("networkidle");
    await expect(other.getByRole("heading", { name: "Private" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("failed tests block approval until the owner approves anyway with a reason", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Tested");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);

  await page.getByLabel("Job text").fill("Answer questions about opening hours.");
  await page.getByRole("button", { name: "Add test conversation" }).click();
  await page.getByLabel("Conversation name").fill("Opening hours");
  await page.getByLabel("Customer says").fill("When do you open?");
  await page.getByLabel("Expectation", { exact: true }).selectOption({ label: "Says" });
  await page.getByLabel("Text", { exact: true }).fill("nine");

  // The e2e Host's fake Model never says "nine", so the test fails.
  await page.getByRole("button", { name: "Run tests" }).click();
  await expect(page.locator('[data-test-result="failed"]')).toBeVisible();
  await expect(page.locator('[data-test-result="failed"]')).toHaveAttribute("open", "");
  await expect(page.getByText("A test failed. Approving needs a reason.")).toBeVisible();

  // Approve is refused, and Approve anyway needs a reason.
  await expect(page.getByRole("button", { name: "Approve as a new Release" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve anyway" })).toBeDisabled();
  await page.getByLabel("Reason for approving anyway").fill("The fake Model cannot say it.");
  await page.getByRole("button", { name: "Approve anyway" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();

  // Editing the draft voids the results: they are no longer shown for it.
  await page.getByLabel("Job text").fill("Answer anything.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("The tests haven't run on this draft.")).toBeVisible();
  await expect(page.locator("[data-test-result]")).toHaveCount(0);
});
