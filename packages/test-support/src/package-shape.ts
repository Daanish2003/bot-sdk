import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** A `@botsdk/*` package's manifest, as a Host gets it (spec #875). */
export type PackageManifest = {
  name: string;
  private?: boolean;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The package folder of a package test: `new URL("..", import.meta.url)` from its `test/`. */
export const packageRootOf = (testUrl: string) => fileURLToPath(new URL("..", testUrl));

/** The `package.json` of the package at `packageRoot`. */
export function packageManifest(packageRoot: string): PackageManifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
}

/** The source files a module imports at load time (static and re-exports; `import type` is skipped). */
function loadedImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gms),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ].map((match) => match[1]!);
  return specifiers
    .filter((specifier) => specifier.startsWith(".") && !specifier.endsWith(".json"))
    .map((specifier) => {
      const base = resolve(dirname(file), specifier);
      const found = [`${base}.ts`, join(base, "index.ts"), base].find(
        (candidate) => existsSync(candidate) && candidate.endsWith(".ts"),
      );
      if (!found) throw new Error(`${file} imports ${specifier}, which isn't a source file`);
      return found;
    });
}

/**
 * Every source file of the package at `packageRoot` reached from `entry` through load-time imports,
 * relative to the package.
 */
export function reachedFrom(packageRoot: string, entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(packageRoot, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const key = relative(packageRoot, file).replaceAll("\\", "/");
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...loadedImports(file));
  }
  return [...seen];
}

const features = ["@botsdk/memory", "@botsdk/skills", "@botsdk/knowledge", "@botsdk/mcp"];

/**
 * The package test of an optional feature (spec #875): the feature at its root, its client part
 * and hooks at `/client` and `/react`, the core as a peer, no other feature, and no components.
 */
export function describeFeaturePackage(name: string, testUrl: string) {
  const packageRoot = packageRootOf(testUrl);
  const manifest = packageManifest(packageRoot);

  describe(name, () => {
    it("exports the feature at the root, and its client part and hooks at /client and /react", () => {
      expect(manifest.name).toBe(name);
      expect(manifest.exports["."]).toBe("./src/index.ts");
      expect(manifest.exports["./client"]).toBe("./src/client/index.ts");
      expect(manifest.exports["./react"]).toBe("./src/react/index.ts");
      for (const [entry, target] of Object.entries(manifest.exports)) {
        if (entry === "./package.json") continue;
        expect(target, entry).toMatch(/^\.\/src\/.+\.ts$/);
        expect(existsSync(join(packageRoot, target)), entry).toBe(true);
      }
    });

    it("takes the core as a peer and depends on no other feature", () => {
      expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(
        expect.arrayContaining(["@botsdk/bot", "@botsdk/client", "@botsdk/react"]),
      );
      const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
      expect(names.filter((other) => features.includes(other) && other !== name)).toEqual([]);
    });

    it("holds no components: they live in @botsdk/ui", () => {
      const files = readdirSync(join(packageRoot, "src"), { recursive: true }) as string[];
      expect(files.filter((file) => file.endsWith(".tsx"))).toEqual([]);
    });

    it("never loads its server part from /client or /react", () => {
      for (const entry of ["src/client/index.ts", "src/react/index.ts"]) {
        const reached = reachedFrom(packageRoot, entry);
        expect(reached, entry).toContain(entry);
        expect(
          reached.filter((file) => file === "src/index.ts" || file.startsWith("src/server/")),
          entry,
        ).toEqual([]);
      }
    });
  });
}
