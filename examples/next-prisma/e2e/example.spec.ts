import { expect, test } from "@playwright/test";
import pg from "pg";

import { chatPage } from "../../../packages/chat-sdk/test/e2e/chat-page";

import { e2eDatabaseUrl } from "./env";
import { exampleHost } from "./host";
import { createUser, seedUser } from "./seed-user";

/** The rows deleting an account must remove: the user's Conversations, and the user itself. */
async function rowsOf(userId: string) {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl });
  await client.connect();
  try {
    const conversations = await client.query(
      "select count(*)::int as n from chat.conversation where user_id = $1",
      [userId],
    );
    const users = await client.query('select count(*)::int as n from "User" where id = $1', [
      userId,
    ]);
    return { conversations: conversations.rows[0].n, users: users.rows[0].n };
  } finally {
    await client.end();
  }
}

test.describe("example Host", () => {
  test("signs in on the form, and refuses a wrong password", async ({ page }) => {
    const user = await createUser();
    await page.goto("/sign-in");

    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "match an account" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/c$/);
    await expect(page.getByRole("link", { name: "Account", exact: true })).toBeVisible();
  });

  test("deleting the account removes its Conversations and its sign-in", async ({ page }) => {
    const user = await seedUser(page);
    const { addFakeOllama, send } = chatPage(expect, exampleHost);
    await addFakeOllama(page);
    await page.goto("/c");
    await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
    await send(page, "Kept until the account is deleted");
    expect(await rowsOf(user.id)).toEqual({ conversations: 1, users: 1 });

    await page.getByRole("link", { name: "Account", exact: true }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page).toHaveURL(/\/sign-in/);

    expect(await rowsOf(user.id)).toEqual({ conversations: 0, users: 0 });
    await page.goto("/c");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
