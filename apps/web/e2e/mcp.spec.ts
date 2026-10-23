import { expect, test } from "@playwright/test";

import { signInAsSeededUserWithModel } from "./helpers";

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

  // The `mcp` plugin owns Connections; the assistant offers no MCP tools, so no Tools menu.
  await page.goto("/c");
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);

  // Disconnecting offers Connect again.
  await page.goto("/settings/keys");
  await connection.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(connection.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(connection).toContainText("Not connected");
});
