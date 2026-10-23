import { expect, test } from "@playwright/test";

import { mcpMarker } from "../../../packages/bot-sdk/test/e2e/fake-ollama";
import { createBot, signInAsSeededUserWithModel } from "./helpers";

const server = "E2E Tracker";

test("a Connection signed in on the keys page stays connected until disconnected, and the composer has no Tools menu", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  // Connect from the keys page: the sign-in goes to the fake authorization server and back.
  await page.goto("/settings/keys");
  const connection = page.getByRole("listitem").filter({ hasText: server });
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection).toContainText("Connected");

  // The Connection is stored: a reload still lists it as connected.
  await page.reload();
  await expect(connection).toContainText("Connected");

  // The `mcp` plugin owns Connections; a Bot's composer has no Tools menu.
  await createBot(page, "Plain");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);

  // Disconnecting offers Connect again.
  await page.goto("/settings/keys");
  await connection.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(connection.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(connection).toContainText("Not connected");
});

test("a Connection made on the Keys page is used by a Bot", async ({ page }) => {
  await signInAsSeededUserWithModel(page);

  await page.goto("/settings/keys");
  const connection = page.getByRole("listitem").filter({ hasText: server });
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection).toContainText("Connected");

  await page.goto("/bots");
  await page.getByRole("button", { name: "New Bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Tracker");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/bots\/[\w-]+$/);

  // The Bot calls the Connector tool through tool search; Auto-review passes it, and the fake
  // server's result (the call's name and arguments) comes back in the Bot's message.
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`${mcpMarker} File the launch issue`);
  await composer.press("Enter");
  await expect(page.locator("[data-bot-message][data-role=assistant]").last()).toContainText(
    "E2E launch",
  );
});
