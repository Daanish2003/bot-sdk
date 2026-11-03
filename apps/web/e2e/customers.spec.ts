import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { signInAsSeededUser } from "./helpers";
import { e2eDatabaseUrl } from "./database";

/** Writes a Customer with one identity and a thread with `messages` into the e2e database. */
async function seedThread(
  userId: string,
  representativeId: string,
  { name, blocked, messages }: { name: string; blocked: boolean; messages: [string, string][] },
) {
  const customerId = randomUUID();
  const threadId = randomUUID();
  const externalId = `+1555${customerId.slice(0, 8)}`;
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    const run = (text: string, values: unknown[]) => db.$client.query(text, values);
    await run(
      "insert into botsdk.representative_customer (id, user_id, name, blocked_at) values ($1, $2, $3, $4)",
      [customerId, userId, name, blocked ? new Date() : null],
    );
    await run(
      "insert into botsdk.representative_customer_identity (id, user_id, customer_id, channel, external_id) values ($1, $2, $3, 'sms', $4)",
      [randomUUID(), userId, customerId, externalId],
    );
    await run(
      "insert into botsdk.representative_thread (id, customer_id, representative_id, last_channel, last_external_id, message_count) values ($1, $2, $3, 'sms', $5, $4)",
      [threadId, customerId, representativeId, messages.length, externalId],
    );
    for (const [position, [author, text]] of messages.entries()) {
      await run(
        "insert into botsdk.representative_thread_message (id, thread_id, position, author, channel, external_id, text) values ($1, $2, $3, $4, 'sms', $6, $5)",
        [randomUUID(), threadId, position + 1, author, text, externalId],
      );
    }
  } finally {
    await db.$client.end();
  }
}

test("an owner adds a Customer, edits identities, and blocks and unblocks one", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await page.goto("/customers");
  await expect(page.getByText("No Customers yet.")).toBeVisible();

  const add = async (name: string, externalId: string) => {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Channel", { exact: true }).fill("sms");
    await page.getByLabel("Identity on that Channel").fill(externalId);
    await page.getByRole("button", { name: "Add Customer" }).click();
    await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
  };
  await add("Ada", "+15550001");
  await add("Bob", "+15550002");
  await expect(page.locator("[data-customer]")).toHaveCount(2);

  // An identity of one of the owner's other Customers is refused.
  const bobId = page.getByLabel("Identity of Bob", { exact: true });
  await bobId.fill("+15550001");
  await page
    .locator("[data-customer]")
    .filter({ has: page.getByLabel("Name of Bob") })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("One of your Customers already has that identity.")).toBeVisible();

  await bobId.fill("+15550003");
  await page
    .locator("[data-customer]")
    .filter({ has: page.getByLabel("Name of Bob") })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Identity of Bob", { exact: true })).toHaveValue("+15550003");

  await page.getByRole("button", { name: "Block Ada" }).click();
  await expect(page.locator("[data-customer][data-blocked=true]")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Unblock Ada" })).toBeVisible();
  await page.getByRole("button", { name: "Unblock Ada" }).click();
  await expect(page.locator("[data-customer][data-blocked=true]")).toHaveCount(0);
});

test("an owner reads a Representative's threads, including a blocked Customer's kept message", async ({
  page,
}) => {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Front desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const representativeId = page.url().split("/").pop()!;
  await expect(page.getByText("No Customer has written yet.")).toBeVisible();

  await seedThread(owner.id, representativeId, {
    name: "Ada",
    blocked: false,
    messages: [
      ["customer", "When do you open?"],
      ["representative", "We open at nine."],
    ],
  });
  await seedThread(owner.id, representativeId, {
    name: "Mallory",
    blocked: true,
    messages: [["customer", "Let me in"]],
  });
  await page.reload();

  const ada = page.locator("[data-thread]").filter({ hasText: "Ada" });
  await expect(ada).toContainText("Held by the Representative");
  await expect(ada).toContainText("Waiting on the Customer");
  await expect(ada).toContainText("2 messages");
  await ada.getByRole("button", { name: "Read Ada" }).click();
  await expect(ada.locator('[data-author="customer"]')).toContainText("When do you open?");
  await expect(ada.locator('[data-author="representative"]')).toContainText("We open at nine.");

  const mallory = page.locator("[data-thread]").filter({ hasText: "Mallory" });
  await expect(mallory).toContainText("Blocked");
  await expect(mallory).not.toContainText("Waiting on");
  await mallory.getByRole("button", { name: "Read Mallory" }).click();
  await expect(mallory.locator('[data-author="customer"]')).toContainText("Let me in");
});
