import { expect, test } from "@playwright/test";

import { createBot, sendToBot, signInAsSeededUser, signInAsSeededUserWithModel } from "./helpers";
import { appWebHost } from "./host";
import {
  draftedRepresentativeName,
  draftedRepresentativeWhy,
  draftRepresentativeMarker,
} from "./support/fake-ollama";

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

test("an owner chooses which Bot a Representative reports to", async ({ page }) => {
  await signInAsSeededUser(page);
  await createBot(page, "Ada");
  await createBot(page, "Grace");

  // With no Bot, it reports to the owner.
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Back office");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const chooser = page.getByLabel("Reports to");
  await expect(chooser).toHaveValue("");
  await expect(chooser.locator("option:checked")).toHaveText("You");

  // Only the owner's Bots are offered, and the choice holds after a reload.
  await expect(chooser.locator("option")).toHaveCount(3);
  await expect(chooser).toContainText("Ada");
  await expect(chooser).toContainText("Grace");
  await chooser.selectOption({ label: "Grace" });
  await expect(page.getByText("Reporting Bot changed").first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Reports to").locator("option:checked")).toHaveText("Grace");

  await page.getByLabel("Reports to").selectOption({ label: "Ada" });
  await expect(page.getByText("Reporting Bot changed").first()).toBeVisible();
  await page.goto("/representatives");
  await expect(page.getByRole("listitem").filter({ hasText: "Back office" })).toContainText(
    "Reports to: Ada",
  );
});

test("an owner reviews the diff against the live Release and rolls back to an earlier one", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Front desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);

  await page.getByLabel("Job text").fill("Answer questions about opening hours.");
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
  await page.getByLabel("Job text").fill("Answer anything.");
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 2")).toBeVisible();

  // The diff shows only what the draft changes against the live Release.
  const diff = page.getByRole("region", { name: "Changes from the live Release" });
  await expect(diff.getByText("The draft matches the live Release.")).toBeVisible();
  await page.getByLabel("Job text").fill("Answer anything, politely.");
  await page.getByRole("checkbox", { name: "Hand off to the Bot" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(diff.locator('[data-change="jobText"]')).toContainText("Answer anything, politely.");
  await expect(diff.locator('[data-change="tool"]')).toContainText("hand_to_bot");
  await expect(diff.locator('[data-change="model"]')).toHaveCount(0);

  // Rolling back changes the live Release and nothing else: the draft is as it was.
  await expect(page.locator('[data-release="2"]')).toContainText("Live");
  await page.getByRole("button", { name: "Roll back to this Release 1" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
  await expect(page.locator('[data-release="1"]')).toContainText("Live");
  await expect(page.locator('[data-release="2"]')).not.toContainText("Live");
  await expect(page.getByLabel("Job text")).toHaveValue("Answer anything, politely.");
  await expect(page.locator("[data-release]")).toHaveCount(2);
  // Both Releases were approved with passing tests, so neither logs a reason.
  await expect(page.locator("[data-override-reason]")).toHaveCount(0);
  await expect(diff.locator('[data-change="jobText"]')).toContainText(
    "Answer questions about opening hours.",
  );

  // It holds after a reload.
  await page.reload();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
});

// #1242: the server's HTML can be typed in before the scripts run. Holding them makes that certain.
test("a Name typed before the page hydrates still counts", async ({ page }) => {
  await appWebHost.signIn(page);
  let releaseScripts!: () => void;
  const scriptsHeld = new Promise<void>((resolve) => (releaseScripts = resolve));
  await page.route("**/assets/*.js", async (route) => {
    await scriptsHeld;
    await route.continue();
  });

  await page.goto("/representatives", { waitUntil: "commit" });
  await page.getByLabel("Name").fill("Early");
  releaseScripts();

  const create = page.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeEnabled();
  await expect(page.getByLabel("Name")).toHaveValue("Early");
  await create.click();
  await expect(page.getByRole("heading", { name: "Early" })).toBeVisible();
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

  // The history shows the logged reason against the Release it was given for.
  await expect(page.locator('[data-release="1"]')).toContainText(
    "Approved anyway: The fake Model cannot say it.",
  );

  // Editing the draft voids the results: they are no longer shown for it.
  await page.getByLabel("Job text").fill("Answer anything.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("The tests haven't run on this draft.")).toBeVisible();
  await expect(page.locator("[data-test-result]")).toHaveCount(0);
});

test("a Bot's draft reaches the owner as a link, and is answered on the Representative's page", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Ada");

  await sendToBot(page, `${draftRepresentativeMarker} Draft a front desk`);
  const card = page.locator("[data-release-approval]");
  await expect(card).toHaveAttribute("data-state", "waiting");
  await expect(card).toContainText(draftedRepresentativeWhy);
  await expect(card.getByRole("button")).toHaveCount(0);

  await card.getByRole("link").click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: draftedRepresentativeName })).toBeVisible();
  await expect(page.getByLabel("Job text")).toHaveValue("Answer questions about opening hours.");
  await expect(page.getByText("No Release yet")).toBeVisible();

  await page.getByRole("button", { name: "Decline the draft" }).click();
  await expect(page.getByText("Declined. The Bot has been told").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline the draft" })).toBeHidden();

  // The draft stays, and can still be approved.
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();

  await page.goto("/bots");
  await page.getByRole("link", { name: "Ada" }).first().click();
  await expect(page.locator("[data-release-approval]")).toHaveAttribute("data-state", "declined");
});

test("an owner picks the draft's Model from the Models they can use, or leaves the default", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await createBot(page, "Ada");
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Front desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Job text").fill("Answer questions.");

  const picker = page.getByRole("button", { name: "Model", exact: true });
  await expect(picker).toHaveText("Pick a Model");
  await expect(page.getByRole("button", { name: "Use the default" })).toBeHidden();

  await picker.click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("group")
    .first()
    .getByRole("button")
    .first()
    .click();
  await expect(picker).not.toHaveText("Pick a Model");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  await page.reload();
  await expect(picker).not.toHaveText("Pick a Model");

  await page.getByRole("button", { name: "Use the default" }).click();
  await expect(picker).toHaveText("Pick a Model");
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
});
