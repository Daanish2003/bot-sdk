import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** What a consumer gets from `@botsdk/react` (spec #875): its export map and peer dependencies. */
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe("@botsdk/react", () => {
  it("leaves React and React Query to the Host", () => {
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      "@tanstack/react-query",
      "react",
    ]);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("react");
  });

  it("exports source, with hooks and no components", () => {
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (entry === "./package.json") continue;
      expect(target, entry).toMatch(/^\.\/src\/.+\.(ts|tsx)$/);
      if (entry !== "./provider") expect(target, entry).not.toMatch(/\.tsx$/);
    }
  });
});
