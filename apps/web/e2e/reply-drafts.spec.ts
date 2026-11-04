import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { e2eDatabaseUrl } from "./database";
import { signInAsSeededUser } from "./helpers";

/** Switches the Representative on and gives it a thread with a Reply draft, as the gate holds one. */
async function seedDraft(
  userId: string,
  representativeId: string,
  { name, text }: { name: string; text: string },
) {
  const customerId = randomUUID();
  const threadId = randomUUID();
  const decisionId = randomUUID();
  const externalId = `+1555${customerId.slice(0, 8)}`;
  const now = new Date();
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    const run = (query: string, values: unknown[]) => db.$client.query(query, values);
    await run("update botsdk.representative set enabled = true where id = $1", [representativeId]);
    await run("insert into botsdk.representative_customer (id, user_id) values ($1, $2)", [
      customerId,
      userId,
    ]);
    await run(
      "insert into botsdk.representative_profile_value (id, user_id, customer_id, fixed_field, value, source, status, recorded_at) values ($1, $2, $3, 'name', $4, 'owner', 'confirmed', $5)",
      [randomUUID(), userId, customerId, name, now],
    );
    await run(
      "insert into botsdk.representative_customer_identity (id, user_id, customer_id, channel, external_id) values ($1, $2, $3, 'sms', $4)",
      [randomUUID(), userId, customerId, externalId],
    );
    await run(
      "insert into botsdk.representative_thread (id, customer_id, representative_id, last_channel, last_external_id, message_count) values ($1, $2, $3, 'sms', $4, 1)",
      [threadId, customerId, representativeId, externalId],
    );
    await run(
      "insert into botsdk.representative_thread_message (id, thread_id, position, author, channel, external_id, text) values ($1, $2, 1, 'customer', 'sms', $3, 'What do I owe?')",
      [randomUUID(), threadId, externalId],
    );
    await run(
      "insert into botsdk.representative_outbound_decision (id, thread_id, kind, outcome, rule, channel, external_id, created_at) values ($1, $2, 'reply', 'hold', 'topic', 'sms', $3, $4)",
      [decisionId, threadId, externalId, now],
    );
    await run(
      "insert into botsdk.representative_held_message (id, decision_id, thread_id, text, verified, reply_kind, sources, topic, created_at) values ($1, $2, $3, $4, false, 'small_talk', '[]', 'billing', $5)",
      [randomUUID(), decisionId, threadId, text, now],
    );
  } finally {
    await db.$client.end();
  }
}

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
  await page.reload();
  await page.getByRole("button", { name: "Remove topic Refunds" }).click();
  await expect(topic).toHaveCount(0);
});
