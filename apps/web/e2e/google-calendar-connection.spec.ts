import { expect, test } from "@playwright/test";

import { signInAsSeededUserWithModel } from "./helpers";
import { seedUser } from "./seed-user";

/** The Connections row for an app, found by its name. */
const connectionRow = (page: import("@playwright/test").Page, name: string) =>
  page
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: /Connected|connect/i });

test("the keys page offers Google Calendar, and Connect asks Google for a refresh token", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);
  await page.goto("/settings/keys");

  const calendar = connectionRow(page, "Google Calendar");
  await expect(calendar.getByText("Not connected")).toBeVisible();

  const authorize = "https://accounts.google.com/o/oauth2/v2/auth";
  // Stub the provider so the navigation is caught and never reaches the real host.
  await page.route(`${new URL(authorize).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
  );
  const request = page.waitForRequest((r) => r.url().startsWith(authorize));
  await calendar.getByRole("button", { name: "Connect", exact: true }).click();
  const url = new URL((await request).url());

  expect(url.searchParams.get("redirect_uri")).toBe(
    `${new URL(page.url()).origin}/api/auth/callback/google-calendar`,
  );
  expect(url.searchParams.get("scope")?.split(" ")).toEqual(
    expect.arrayContaining([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ]),
  );
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
});

test("a connected Google Calendar shows as connected, and Disconnect removes it", async ({
  page,
}) => {
  await seedUser(page, { linked: ["google-calendar"] });
  await page.goto("/settings/keys");

  const calendar = connectionRow(page, "Google Calendar");
  await expect(calendar.getByText("Connected", { exact: true })).toBeVisible();

  await calendar.getByRole("button", { name: "Disconnect" }).click();
  await expect(calendar.getByText("Not connected")).toBeVisible();
});
