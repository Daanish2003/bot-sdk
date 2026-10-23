import { expect, test } from "@playwright/test";

import { appWebHost } from "./host";

// #821: a second React in the SSR build made signed-in pages fail to server-render and fall back
// to the browser. The account menu is in the server's HTML only when the page rendered there.
test("a signed-in page renders on the server", async ({ page }) => {
  const user = await appWebHost.signIn(page);

  const response = await page.request.get("/bots");

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain(`>${user.name}</span>`);
});

// #819: the assistant's pages are gone; their old URLs fall through to the not-found page.
test("an old Conversation URL shows the not-found page", async ({ page }) => {
  await appWebHost.signIn(page);

  await page.goto("/c/0196a000-0000-7000-8000-000000000001");

  await expect(page.getByText("Not Found", { exact: true })).toBeVisible();
});
