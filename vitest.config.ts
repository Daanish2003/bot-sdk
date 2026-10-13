import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const testFiles = ["{apps,packages}/*/{src,test}/**/*.test.ts"];
const integrationTestFiles = ["{apps,packages}/*/{src,test}/**/*.integration.test.ts"];

// The Chat SDK's `ui/` imports shadcn primitives as `@/components/ui/*` and `@/lib/utils`.
// In this repo those live in packages/ui.
const uiSource = fileURLToPath(new URL("./packages/ui/src", import.meta.url));
const webSource = fileURLToPath(new URL("./apps/web/src", import.meta.url));
const shadcnAliases = [
  { find: /^@\/components\/ui\/(.*)$/, replacement: `${uiSource}/components/$1` },
  { find: /^@\/lib\/utils$/, replacement: `${uiSource}/lib/utils` },
];

export default defineConfig({
  test: {
    // Several worktrees often run the suite at once; `--maxWorkers` on the command line overrides it.
    maxWorkers: 2,
    projects: [
      {
        resolve: { alias: shadcnAliases },
        test: {
          name: "unit",
          include: testFiles,
          exclude: integrationTestFiles,
        },
      },
      {
        // apps/web components render in jsdom and import the app's `@/` modules from apps/web/src.
        resolve: {
          alias: [...shadcnAliases, { find: /^@\/(.*)$/, replacement: `${webSource}/$1` }],
        },
        test: {
          name: "web-components",
          environment: "jsdom",
          // The first render of a component pulls in the whole app's module graph.
          testTimeout: 30000,
          include: ["apps/web/src/**/*.test.tsx"],
        },
      },
      {
        resolve: { alias: shadcnAliases },
        test: {
          name: "integration",
          // Integration tests share one Postgres database (TEST_DATABASE_URL),
          // so their files run one at a time.
          include: integrationTestFiles,
          fileParallelism: false,
          globalSetup: ["packages/chat-sdk/test/support/global-setup.ts"],
          setupFiles: ["packages/chat-sdk/test/support/setup.ts"],
        },
      },
    ],
  },
});
