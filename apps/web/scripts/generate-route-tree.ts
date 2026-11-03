/// <reference types="node" />
/**
 * Writes `src/routeTree.gen.ts` without building the app, so `check-types` can run `tsc` on its
 * own. TanStack Start's router generator writes the file when Vite resolves the config, which is
 * all this does. It skips vite.config.ts, whose Varlock plugin stops on a missing env value (a
 * typecheck reads no env), and uses that file's `tanstackStart()` alone, so options given there
 * belong here too. The generator only logs its errors, so the old file is removed first and a
 * missing file fails the script. Run from apps/web.
 */
import { existsSync, rmSync } from "node:fs";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { resolveConfig } from "vite";

const routeTree = "src/routeTree.gen.ts";

rmSync(routeTree, { force: true });
await resolveConfig({ configFile: false, plugins: [tanstackStart()] }, "build");
if (!existsSync(routeTree)) {
  console.error(`${routeTree} was not generated; see the router generator's error above.`);
  process.exit(1);
}
