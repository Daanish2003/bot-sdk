import { expect, test } from "@playwright/test";

import { createBot, signInAsSeededUserWithModel } from "./helpers";
import { seedUser } from "./seed-user";

/** The Connections row for an app, found by its name. */
const connectionRow = (page: import("@playwright/test").Page, name: string) =>
  page
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: /Connected|connect/i });

test("the keys page offers GitHub, and Connect starts the link at GitHub's authorize URL", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/settings/keys");

  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  const github = connectionRow(page, "GitHub");
  await expect(github.getByText("Not connected")).toBeVisible();

  const authorize = "https://github.com/login/oauth/authorize";
  // Stub the provider so the navigation is caught and never reaches the real host.
  await page.route(`${new URL(authorize).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
  );
  const request = page.waitForRequest((r) => r.url().startsWith(authorize));
  await github.getByRole("button", { name: "Connect", exact: true }).click();
  const url = new URL((await request).url());

  expect(url.searchParams.get("redirect_uri")).toBe(
    `${new URL(page.url()).origin}/api/auth/callback/github-connection`,
  );
  expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
    "notifications",
    "read:org",
    "repo",
  ]);
});

test("a connected GitHub shows as connected, and Disconnect removes it", async ({ page }) => {
  await seedUser(page, { linked: ["github-connection"] });
  await page.goto("/settings/keys");

  const github = connectionRow(page, "GitHub");
  await expect(github.getByText("Connected", { exact: true })).toBeVisible();

  await github.getByRole("button", { name: "Disconnect" }).click();
  await expect(github.getByText("Not connected")).toBeVisible();
});

test("a Bot's composer has no Tools menu until GitHub is connected", async ({ page }) => {
  await signInAsSeededUserWithModel(page);

  await createBot(page, "Plain");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
});
