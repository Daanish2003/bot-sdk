import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// The `@botsdk/*` packages sit one level deeper, in packages/botsdk/<name> (spec #875).
const testFiles = [
  "{apps,packages}/*/{src,test}/**/*.test.ts",
  "packages/botsdk/*/{src,test}/**/*.test.ts",
];
const integrationTestFiles = [
  "{apps,packages}/*/{src,test}/**/*.integration.test.ts",
  "packages/botsdk/*/{src,test}/**/*.integration.test.ts",
];

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
// leak into, so the files that mock a module (in their own text) run isolated in their own project.
// Watch mode reruns files in reused workers, where a module-level registry (`defineJob`) would see
// its file's definitions twice, so there every integration file is isolated.
const watching = !process.argv.includes("run");
const mockingIntegrationTestFiles = globSync(integrationTestFiles, { cwd: rootDir })
  .filter((file) => /\bvi\.(mock|doMock)\(/.test(readFileSync(join(rootDir, file), "utf8")))
  .map((file) => file.replaceAll("\\", "/"));

// Each worker has its own copy of the test database (global setup), so integration files run in
// parallel. Both projects name the global setup; it makes the copies once per run.
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
          exclude: [...configDefaults.exclude, ...mockingIntegrationTestFiles],
          isolate: watching,
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
