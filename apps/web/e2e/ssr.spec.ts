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
