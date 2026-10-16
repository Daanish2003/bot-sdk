/// <reference types="node" />
/**
 * Writes `src/routeTree.gen.ts` without building the app, so `check-types` can run `tsc` on its
 * own. TanStack Start's router generator writes the file when Vite resolves the config, which is
 * all this does. Run from apps/web.
 */
import { resolveConfig } from "vite";

await resolveConfig({}, "build");
