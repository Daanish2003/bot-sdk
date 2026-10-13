import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const testFiles = ["{apps,packages}/*/{src,test}/**/*.test.ts"];
const integrationTestFiles = ["{apps,packages}/*/{src,test}/**/*.integration.test.ts"];

// The Chat SDK's `ui/` imports shadcn primitives as `@/components/ui/*` and `@/lib/utils`.
// In this repo those live in packages/ui.
const uiSource = fileURLToPath(new URL("./packages/ui/src", import.meta.url));
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
