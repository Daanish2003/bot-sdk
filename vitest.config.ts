import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const testFiles = ["{apps,packages}/*/{src,test}/**/*.test.ts"];
const integrationTestFiles = ["{apps,packages}/*/{src,test}/**/*.integration.test.ts"];

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// The Bot SDK's `ui/` imports shadcn primitives as `@/components/ui/*` and `@/lib/utils`.
// In this repo those live in packages/ui.
const uiSource = fileURLToPath(new URL("./packages/ui/src", import.meta.url));
const webSource = fileURLToPath(new URL("./apps/web/src", import.meta.url));
const shadcnAliases = [
  { find: /^@\/components\/ui\/(.*)$/, replacement: `${uiSource}/components/$1` },
  { find: /^@\/lib\/utils$/, replacement: `${uiSource}/lib/utils` },
];

// Integration files share one module graph per worker (`isolate: false`), which a `vi.mock` would
// leak into, so the files that mock a module run isolated in their own project.
const mockingIntegrationTestFiles = globSync(integrationTestFiles, { cwd: rootDir })
  .filter((file) => /\bvi\.(mock|doMock)\(/.test(readFileSync(join(rootDir, file), "utf8")))
  .map((file) => file.replaceAll("\\", "/"));

// Each worker has its own copy of the test database (global setup), so integration files run in
// parallel. The global setup runs once per project, and the second run reuses the first's copies.
const integrationTest = {
  globalSetup: ["packages/bot-sdk/test/support/global-setup.ts"],
  setupFiles: ["packages/bot-sdk/test/support/setup.ts"],
};

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
          ...integrationTest,
          name: "integration",
          include: integrationTestFiles,
          exclude: mockingIntegrationTestFiles,
          isolate: false,
        },
      },
      {
        resolve: { alias: shadcnAliases },
        test: {
          ...integrationTest,
          name: "integration-mocked",
          include: mockingIntegrationTestFiles,
        },
      },
    ],
  },
});
