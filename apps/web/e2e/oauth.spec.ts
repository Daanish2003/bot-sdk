import { expect, test } from "@playwright/test";

import { baseURL, serverEnv } from "./env";

// OAuth stays manual (#68): nothing calls the real providers. Each button's navigation is caught
// on its way to the provider and never followed, so only the authorize URL is checked.
const providers = [
  {
    button: "Continue with GitHub",
    provider: "github",
    authorize: "https://github.com/login/oauth/authorize",
    clientId: serverEnv.GITHUB_CLIENT_ID,
  },
  {
    button: "Continue with Google",
    provider: "google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: serverEnv.GOOGLE_CLIENT_ID,
  },
] as const;

for (const { button, provider, authorize, clientId } of providers) {
  test(`"${button}" starts the ${provider} flow with the configured client and callback`, async ({
    page,
  }) => {
    await page.goto("/login");
    // Stub the provider so the navigation is caught and never reaches the real host.
    await page.route(`${new URL(authorize).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
    );

    const request = page.waitForRequest((r) => r.url().startsWith(authorize));
    await page.getByRole("button", { name: button }).click();
    const url = new URL((await request).url());

    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/${provider}`);
    if (provider === "google") {
      expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
        "email",
        "openid",
        "profile",
      ]);
    }
  });
}
