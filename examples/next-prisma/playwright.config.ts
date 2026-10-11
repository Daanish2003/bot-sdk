import { defineConfig, devices } from "@playwright/test";

import { baseURL, serverEnv } from "./e2e/env";

/**
 * End-to-end tests against the production build, the example's own database (`e2e/prepare-database.ts`)
 * and a fake Ollama host (`packages/chat-sdk/test/e2e/fake-ollama.ts`), so no Provider key is needed.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
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
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm db:migrate && pnpm exec next start --port 3100",
    url: `${baseURL}/sign-in`,
    env: serverEnv,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
