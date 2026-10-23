import { expect, type Page, test } from "@playwright/test";

import { signInAsSeededUser } from "./helpers";

/** Opens the login page and waits until the service worker controls it (it claims at once). */
async function controlledPage(page: Page) {
  await page.goto("/login");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("the manifest is served, and its icons are PNGs", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/", scope: "/" });

  for (const icon of manifest.icons) {
    const served = await request.get(icon.src);
    expect(served.ok(), icon.src).toBeTruthy();
    expect(served.headers()["content-type"], icon.src).toContain("image/png");
  }
});

test("the service worker registers and controls the page", async ({ page }) => {
  await controlledPage(page);
  const scriptURL = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).active?.scriptURL,
  );
  expect(new URL(scriptURL!).pathname).toBe("/sw.js");
});

test("the worker never answers for the API", async ({ page, context }) => {
  await controlledPage(page);
  await context.setOffline(true);
  try {
    // Nothing cached: the API request fails with the network, not with an answer from the worker.
    const outcome = await page.evaluate(() =>
      fetch("/api/auth/get-session").then(
        () => "answered",
        () => "failed",
      ),
    );
    expect(outcome).toBe("failed");

    // A navigation to the API isn't handled either; the offline page would answer a handled one.
    await expect(page.goto("/api/auth/get-session")).rejects.toThrow();
  } finally {
    await context.setOffline(false);
  }
});

test("with the network cut, a navigation shows the offline page", async ({ page, context }) => {
  await controlledPage(page);
  await context.setOffline(true);
  try {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("the install row is in the Bots sidebar and goes once dismissed", async ({ page }) => {
  await signInAsSeededUser(page);
  const drawer = page.getByRole("complementary", { name: "Bots" });
  const install = drawer.getByRole("button", { name: "Install", exact: true });

  // Chromium offers the install prompt only when it decides to; the test offers it directly.
  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt")));
  await expect(install).toBeVisible();

  await drawer.getByRole("button", { name: "Not now" }).click();
  await expect(install).toBeHidden();

  // The dismissal is remembered: a new load doesn't show the row even when the prompt is offered.
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt")));
  await expect(drawer.getByRole("button", { name: "Not now" })).toHaveCount(0);
  await expect(install).toHaveCount(0);
});
