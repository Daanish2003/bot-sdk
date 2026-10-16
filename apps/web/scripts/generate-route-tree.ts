/// <reference types="node" />
/**
 * Writes `src/routeTree.gen.ts` without building the app, so `check-types` can run `tsc` on its
 * own. TanStack Start's router generator writes the file when Vite resolves the config, which is
 * all this does. The generator only logs its errors, so the old file is removed first and a missing
 * file fails the script. Run from apps/web.
 */
import { existsSync, rmSync } from "node:fs";

import { resolveConfig } from "vite";

const routeTree = "src/routeTree.gen.ts";

rmSync(routeTree, { force: true });
await resolveConfig({}, "build");
if (!existsSync(routeTree)) {
  console.error(`${routeTree} was not generated; see the router generator's error above.`);
  process.exit(1);
}
