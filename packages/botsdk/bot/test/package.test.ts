import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packageManifest, packageRootOf, reachedFrom } from "@ai-chat/test-support/package-shape";

const packageRoot = packageRootOf(import.meta.url);

/** What a Host gets from `@botsdk/bot` (spec #875): its export map, entries and dependencies. */
const manifest = packageManifest(packageRoot);

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
    const reached = reachedFrom(packageRoot, "src/index.ts");

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
