import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** What a consumer gets from `@botsdk/client` (spec #875): its export map, entries and dependencies. */
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Browser-safe packages the client may depend on: no server code, no database, no SDK server. */
const browserSafe = new Set(["@orpc/client", "@orpc/contract", "@orpc/tanstack-query", "zod"]);

describe("@botsdk/client", () => {
  it("imports every entry of its export map by name", async () => {
    const entries = Object.keys(manifest.exports).filter((entry) => entry !== "./package.json");
    expect(entries).toContain(".");
    for (const entry of entries) {
      const specifier = `${manifest.name}${entry.slice(1)}`;
      const module: unknown = await import(/* @vite-ignore */ specifier);
      expect(module, specifier).toBeTypeOf("object");
    }
  });

  it("points every entry at source, so the workspace imports it without a build", () => {
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (entry === "./package.json") continue;
      expect(target, entry).toMatch(/^\.\/src\/.+\.ts$/);
    }
  });

  it("has no server dependencies", () => {
    const dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    });
    expect(dependencies.filter((name) => !browserSafe.has(name))).toEqual([]);
  });

  it("creates the client from its main entry", async () => {
    const { coreContract, createBotSdkClient } = await import("@botsdk/client");
    const client = createBotSdkClient({ baseUrl: "https://app.example/api/chat/" });
    expect(client.eventsUrl).toBe("https://app.example/api/chat/events");
    expect(Object.keys(coreContract)).toContain("models");
  });
});
