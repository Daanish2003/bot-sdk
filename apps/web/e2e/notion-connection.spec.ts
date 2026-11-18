import { expect, test } from "@playwright/test";

import { signInAsSeededUserWithModel } from "./helpers";
import { seedUser } from "./seed-user";

/** The Connections row for an app, found by its name. */
const connectionRow = (page: import("@playwright/test").Page, name: string) =>
  page
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: /Connected|connect/i });

test("the keys page offers Notion, and Connect asks Notion to authorize as the user", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/settings/keys");

  const notion = connectionRow(page, "Notion");
  await expect(notion.getByText("Not connected")).toBeVisible();

  const authorize = "https://api.notion.com/v1/oauth/authorize";
  // Stub the provider so the navigation is caught and never reaches the real host.
  await page.route(`${new URL(authorize).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
  );
  const request = page.waitForRequest((r) => r.url().startsWith(authorize));
  await notion.getByRole("button", { name: "Connect", exact: true }).click();
  const url = new URL((await request).url());

  expect(url.searchParams.get("redirect_uri")).toBe(
    `${new URL(page.url()).origin}/api/auth/callback/notion`,
  );
  expect(url.searchParams.get("client_id")).toBe("e2e-notion-client-id");
  expect(url.searchParams.get("owner")).toBe("user");
});

test("a linked Notion shows Connected, and Disconnect unlinks it alone", async ({ page }) => {
  await seedUser(page, { linked: ["notion", "gmail"] });
  await page.goto("/settings/keys");

  const notion = connectionRow(page, "Notion");
  const gmail = connectionRow(page, "Gmail");
  await expect(notion.getByText("Connected", { exact: true })).toBeVisible();
  await expect(gmail.getByText("Connected", { exact: true })).toBeVisible();

  await notion.getByRole("button", { name: "Disconnect" }).click();
  await expect(notion.getByText("Not connected")).toBeVisible();
  await expect(gmail.getByText("Connected", { exact: true })).toBeVisible();
});
