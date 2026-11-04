import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { expect, test } from "@playwright/test";

import { signInAsSeededUser } from "./helpers";
import { e2eDatabaseUrl } from "./database";

/** Writes a Customer with one identity and a thread with `messages` into the e2e database. */
async function seedThread(
  userId: string,
  representativeId: string,
  {
    name,
    blocked,
    verified = false,
    messages,
  }: { name: string; blocked: boolean; verified?: boolean; messages: [string, string][] },
) {
  const customerId = randomUUID();
  const threadId = randomUUID();
  const externalId = `+1555${customerId.slice(0, 8)}`;
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    const run = (text: string, values: unknown[]) => db.$client.query(text, values);
    await run(
      "insert into botsdk.representative_customer (id, user_id, blocked_at) values ($1, $2, $3)",
      [customerId, userId, blocked ? new Date() : null],
    );
    await run(
      "insert into botsdk.representative_profile_value (id, user_id, customer_id, fixed_field, value, source, status, recorded_at) values ($1, $2, $3, 'name', $4, 'owner', 'confirmed', $5)",
      [randomUUID(), userId, customerId, name, new Date()],
    );
    await run(
      "insert into botsdk.representative_customer_identity (id, user_id, customer_id, channel, external_id, verified_contact_at) values ($1, $2, $3, 'sms', $4, $5)",
      [randomUUID(), userId, customerId, externalId, verified ? new Date() : null],
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
  return threadId;
}

test("an owner defines a profile field, and sets and corrects a Customer's values", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await page.goto("/customers");

  await page.getByLabel("Name", { exact: true }).fill("Grace");
  await page.getByLabel("Channel", { exact: true }).fill("sms");
  await page.getByLabel("Identity on that Channel").fill(`+1555${randomUUID().slice(0, 8)}`);
  await page.getByRole("button", { name: "Add Customer" }).click();
  const grace = page.locator("[data-customer]").filter({ has: page.getByLabel("Name of Grace") });
  const today = await page.evaluate(() => new Date().toLocaleDateString());
  await expect(grace).toContainText(`Confirmed · from you · ${today}`);

  await page.getByLabel("New profile field").fill("Equipment");
  await page.getByRole("button", { name: "Add field" }).click();
  await grace.getByRole("textbox", { name: "Equipment of Grace" }).fill("Boiler");
  await grace.getByRole("button", { name: "Save Equipment of Grace" }).click();
  const value = grace.locator("form", {
    has: page.getByRole("textbox", { name: "Equipment of Grace" }),
  });
  await expect(value).toContainText(`Confirmed · from you · ${today}`);

  await page.getByRole("textbox", { name: "Field Equipment" }).fill("Heating");
  await page.getByRole("button", { name: "Rename field Equipment" }).click();
  const heating = grace.getByRole("textbox", { name: "Heating of Grace" });
  await expect(heating).toHaveValue("Boiler");

  await page.reload();
  await expect(heating).toHaveValue("Boiler");
  await page.getByRole("button", { name: "Remove field Heating" }).click();
  await expect(heating).toHaveCount(0);
});

test("an owner sees what goes, then deletes a Customer and those merged into them", async ({
  page,
}) => {
  await signInAsSeededUser(page);
  await page.goto("/customers");
  const add = async (name: string, externalId: string) => {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Channel", { exact: true }).fill("sms");
    await page.getByLabel("Identity on that Channel").fill(externalId);
    await page.getByRole("button", { name: "Add Customer" }).click();
    await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
  };
  const emilNumber = `+1555${randomUUID().slice(0, 8)}`;
  await add("Dora", `+1555${randomUUID().slice(0, 8)}`);
  await add("Emil", emilNumber);
  await add("Fay", `+1555${randomUUID().slice(0, 8)}`);
  await page.getByLabel("Merge Dora into").selectOption({ label: `Emil · ${emilNumber}` });
  await page.getByRole("button", { name: "Merge Dora", exact: true }).click();
  await expect(page.getByLabel("Name of Dora")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete Emil" }).click();
  const dialog = page.getByRole("dialog");
  const goes = dialog.getByRole("region", { name: "What goes" });
  await expect(goes).toContainText("Their profile values and summaries");
  await expect(goes).toContainText("Their threads and every message in them");
  await expect(goes).toContainText("Dora");
  const stays = dialog.getByRole("region", { name: "What stays" });
  await expect(stays).toContainText("spend records");
  await expect(stays).toContainText("Gaps");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Name of Emil")).toBeVisible();

  await page.getByRole("button", { name: "Delete Emil" }).click();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page.getByLabel("Name of Emil")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Name of Fay")).toBeVisible();
  await expect(page.getByLabel("Name of Emil")).toHaveCount(0);
  await expect(page.locator("[data-merge]")).toHaveCount(0);
});

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

test("an owner merges two Customers and undoes the merge", async ({ page }) => {
  await signInAsSeededUser(page);
  await page.goto("/customers");
  const add = async (name: string, externalId: string) => {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Channel", { exact: true }).fill("sms");
    await page.getByLabel("Identity on that Channel").fill(externalId);
    await page.getByRole("button", { name: "Add Customer" }).click();
    await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
  };
  await add("Ada", "+15550001");
  await add("Bob", "+15550002");

  await page.getByLabel("Merge Bob into").selectOption({ label: "Ada · +15550001" });
  await page.getByRole("button", { name: "Merge Bob" }).click();

  await expect(page.getByLabel("Name of Bob")).toHaveCount(0);
  await expect(page.locator("[data-customer]")).toHaveCount(1);
  await expect(page.getByLabel("Identity of Ada", { exact: true })).toHaveCount(2);
  await expect(page.locator("[data-merge]")).toContainText("Bob into Ada");
  await page.reload();
  await expect(page.locator("[data-customer]")).toHaveCount(1);

  await page.getByRole("button", { name: "Undo merging Bob into Ada" }).click();

  await expect(page.locator("[data-customer]")).toHaveCount(2);
  await expect(page.getByLabel("Identity of Bob", { exact: true })).toHaveValue("+15550002");
  await expect(page.getByLabel("Identity of Ada", { exact: true })).toHaveValue("+15550001");
  await expect(page.locator("[data-merge]")).toContainText("Undone");
  await expect(page.getByRole("button", { name: "Undo merging Bob into Ada" })).toHaveCount(0);
});

test("an owner reads a closed thread's summary and follows it to the transcript", async ({
  page,
}) => {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Reception");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const representativeId = page.url().split("/").pop()!;

  const threadId = await seedThread(owner.id, representativeId, {
    name: "Lin",
    blocked: false,
    messages: [["customer", "When do you open?"]],
  });
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.$client.query(
      "update botsdk.representative_thread set state = 'closed' where id = $1",
      [threadId],
    );
    await db.$client.query(
      "insert into botsdk.representative_customer_summary (id, thread_id, user_id, text, created_at) values ($1, $2, $3, 'Asked when we open.', now())",
      [randomUUID(), threadId, owner.id],
    );
  } finally {
    await db.$client.end();
  }

  await page.goto("/customers");
  const summary = page.locator("[data-summary]");
  await expect(summary).toContainText("Asked when we open.");
  await expect(summary).toContainText("Reception");
  await expect(summary).not.toContainText("When do you open?");
  await summary.getByRole("button", { name: /^Read/ }).click();
  await expect(summary).toContainText("When do you open?");
});

test("an owner takes over a thread, writes to the Customer and hands it back", async ({ page }) => {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Reception");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  const representativeId = page.url().split("/").pop()!;

  await seedThread(owner.id, representativeId, {
    name: "Grace",
    blocked: false,
    messages: [["customer", "Can I talk to someone?"]],
  });
  await page.reload();

  const grace = page.locator("[data-thread]").filter({ hasText: "Grace" });
  await expect(grace).toContainText("Held by the Representative");
  await grace.getByRole("button", { name: "Read Grace" }).click();
  await expect(grace.getByRole("button", { name: "Hand back" })).toHaveCount(0);

  await grace.getByRole("button", { name: "Take over" }).click();
  await expect(grace).toContainText("Held by you");
  await expect(grace).toContainText("Waiting on you");
  await expect(grace.locator('[data-author="note"]')).toContainText("A person has joined");

  await grace.getByLabel("Your message to the Customer").fill("Hi, this is the owner.");
  await grace.getByRole("button", { name: "Send", exact: true }).click();
  await expect(grace.locator('[data-author="owner"]')).toContainText("Hi, this is the owner.");
  await expect(grace).toContainText("Waiting on the Customer");
  await expect(grace.getByLabel("Your message to the Customer")).toHaveValue("");

  await page.reload();
  await expect(grace).toContainText("Held by you");
  await grace.getByRole("button", { name: "Read Grace" }).click();
  await grace.getByRole("button", { name: "Hand back" }).click();
  await expect(grace).toContainText("Held by the Representative");
  await expect(grace).toContainText("Waiting on the Customer");
  await expect(grace.getByRole("button", { name: "Take over" })).toBeVisible();
  await expect(grace.getByLabel("Your message to the Customer")).toHaveCount(0);
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
    verified: true,
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
  await expect(ada.locator('[data-verified="true"]')).toContainText("Verified");

  const mallory = page.locator("[data-thread]").filter({ hasText: "Mallory" });
  await expect(mallory).toContainText("Blocked");
  await expect(mallory).not.toContainText("Waiting on");
  await mallory.getByRole("button", { name: "Read Mallory" }).click();
  await expect(mallory.locator('[data-author="customer"]')).toContainText("Let me in");
  await expect(mallory.locator('[data-verified="false"]')).toContainText("Not verified");

  await page.goto("/customers");
  const customer = (name: string) =>
    page.locator("[data-customer]").filter({ has: page.getByLabel(`Name of ${name}`) });
  await expect(customer("Ada").locator('[data-verified="true"]')).toContainText("Verified");
  await expect(customer("Mallory").locator('[data-verified="false"]')).toContainText(
    "Not verified",
  );
});
