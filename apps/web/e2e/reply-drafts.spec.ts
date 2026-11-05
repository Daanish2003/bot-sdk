import { expect, test } from "@playwright/test";

import { signInAsSeededUser } from "./helpers";
import { seedDraft } from "./support/reply-drafts";

test("an owner approves, edits and rejects the replies waiting for them", async ({ page }) => {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Billing desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const representativeId = page.url().split("/").pop()!;
  await expect(page.getByText("No replies are waiting.")).toBeVisible();

  // Markup in a reply shows as the text it is.
  await seedDraft(owner.id, representativeId, { name: "Ana", text: "<b>Ten</b> dollars." });
  await seedDraft(owner.id, representativeId, { name: "Ben", text: "Twenty dollars." });
  await seedDraft(owner.id, representativeId, { name: "Cal", text: "Thirty dollars." });
  await page.reload();

  const drafts = page.locator("[data-reply-draft]");
  await expect(drafts).toHaveCount(3);
  const ana = drafts.filter({ hasText: "To Ana" });
  await expect(ana).toContainText("<b>Ten</b> dollars.");
  await expect(ana.locator("b")).toHaveCount(0);
  await expect(ana).toContainText("Topic: billing");
  await ana.getByRole("button", { name: "Approve and send" }).click();
  await expect(drafts).toHaveCount(2);
  const anaThread = page.locator("[data-thread]").filter({ hasText: "Ana" });
  await anaThread.getByRole("button", { name: "Read Ana" }).click();
  await expect(anaThread.locator('[data-author="representative"]')).toContainText(
    "<b>Ten</b> dollars.",
  );

  const ben = drafts.filter({ hasText: "To Ben" });
  await ben.getByRole("button", { name: "Edit" }).click();
  await ben.getByLabel("Your edit of this reply").fill("Twenty-five dollars.");
  await ben.getByRole("button", { name: "Send edited" }).click();
  await expect(drafts).toHaveCount(1);
  const benThread = page.locator("[data-thread]").filter({ hasText: "Ben" });
  await benThread.getByRole("button", { name: "Read Ben" }).click();
  await expect(benThread.locator('[data-author="owner"]')).toContainText("Twenty-five dollars.");

  await drafts.filter({ hasText: "To Cal" }).getByRole("button", { name: "Reject" }).click();
  await expect(drafts).toHaveCount(0);
  const calThread = page.locator("[data-thread]").filter({ hasText: "Cal" });
  await calThread.getByRole("button", { name: "Read Cal" }).click();
  await expect(calThread.locator('[data-author="representative"]')).toHaveCount(0);

  await page.getByLabel("New topic").fill("Refunds");
  await page.getByRole("button", { name: "Add topic" }).click();
  const topic = page.locator('[data-topic-name="Refunds"]');
  await expect(topic).toContainText("draft");
  await page
    .getByRole("button", { name: "Let replies on topic Refunds send without your approval" })
    .click();
  await expect(topic).toContainText("auto");
  await page
    .getByRole("button", { name: "Make replies on topic Refunds wait for your approval" })
    .click();
  await expect(topic).toContainText("draft");
  await page.reload();
  await page.getByRole("button", { name: "Remove topic Refunds" }).click();
  await expect(topic).toHaveCount(0);
});
