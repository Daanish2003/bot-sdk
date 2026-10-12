import { defineConfig, devices } from "@playwright/test";

import { baseURL, mcpBaseURL, serverEnv } from "./e2e/env";

/**
 * End-to-end tests against the production build, its own database (`e2e/start-server.ts`) and
 * a fake Ollama host (`packages/chat-sdk/test/e2e/fake-ollama.ts`), so no Provider key is needed. `*.phone.spec.ts`
 * runs on a phone, the rest on a desktop browser. `mcp.spec.ts` runs against the server that
 * offers one MCP server (`mcpBaseURL`), and the rest against the server that offers none.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // The tests that sign up or sign in through the form may wait out Better Auth's rate limit.
  // The shared scenarios seed their users instead.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // In CI, "list" too: a run cancelled at its timeout still shows which tests ran and how.
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop",
      // redis.spec.ts needs REDIS_URL, which only a run with Redis provides.
      testIgnore: process.env.REDIS_URL
        ? [/\.phone\.spec\.ts$/, /mcp\.spec\.ts$/]
        : [/\.phone\.spec\.ts$/, /redis\.spec\.ts$/, /mcp\.spec\.ts$/],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mcp",
      testMatch: /mcp\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: mcpBaseURL,
      },
    },
    { name: "phone", testMatch: /\.phone\.spec\.ts$/, use: { ...devices["Pixel 7"] } },
  ],
  // E2E_EXTERNAL_SERVER=1: CI runs the suite against the image's containers already listening on
  // `baseURL` and `mcpBaseURL` (ci.yml), so Playwright starts none.
  webServer: process.env.E2E_EXTERNAL_SERVER
    ? undefined
    : {
        command: "pnpm build && node e2e/start-server.ts",
        url: `${baseURL}/login`,
        env: serverEnv,
        timeout: 300_000,
        reuseExistingServer: !process.env.CI,
      },
});
