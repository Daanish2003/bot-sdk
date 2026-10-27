import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** What a Host gets from `@botsdk/bot` (spec #875): its export map, entries and dependencies. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

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

/** Every source file reached from `entry` through load-time imports, relative to the package. */
function reachedFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(packageRoot, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const key = relative(packageRoot, file).replaceAll("\\", "/");
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...loadedImports(file));
  }
  return seen;
}

describe("@botsdk/bot", () => {
  it("has the HTTP layer at /http, apart from the root", () => {
    expect(manifest.name).toBe("@botsdk/bot");
    expect(manifest.exports["."]).toBe("./src/index.ts");
    expect(manifest.exports["./http"]).toBe("./src/http/index.ts");
  });

  it("points every entry at a source file, so the workspace imports it without a build", () => {
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (entry === "./package.json") continue;
      expect(target, entry).toMatch(/^\.\/(src|bin)\/.+\.(ts|mjs)$/);
      expect(existsSync(join(packageRoot, target)), entry).toBe(true);
    }
  });

  it("doesn't load the HTTP layer when the root is imported", () => {
    const reached = [...reachedFrom("src/index.ts")];

    expect(reached).toContain("src/index.ts");
    expect(reached.filter((file) => file.startsWith("src/http/"))).toEqual([]);
  });

  it("depends on no @tanstack/ai-* model provider: the Host installs those", () => {
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });

    expect(dependencies).toContain("@tanstack/ai");
    // `@tanstack/ai-computer-use` is the portable computer-use tool, not a Provider.
    expect(
      dependencies.filter(
        (name) => name.startsWith("@tanstack/ai-") && name !== "@tanstack/ai-computer-use",
      ),
    ).toEqual([]);
  });
});
