import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packageManifest, packageRootOf } from "@ai-chat/test-support/package-shape";

import * as testing from "../src";

const packageRoot = packageRootOf(import.meta.url);

/** What a Host gets from `@botsdk/testing` (spec #875): its export map and dependencies. */
const manifest = packageManifest(packageRoot);

describe("@botsdk/testing", () => {
  it("points every entry at a source file, so the workspace imports it without a build", () => {
    expect(manifest.name).toBe("@botsdk/testing");
    expect(manifest.private).toBeUndefined();
    expect(manifest.exports["."]).toBe("./src/index.ts");
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (entry === "./package.json") continue;
      expect(target, entry).toMatch(/^\.\/src\/.+\.ts$/);
      expect(existsSync(join(packageRoot, target)), entry).toBe(true);
    }
  });

  it("gives a Host a test SDK, a scripted model adapter, a fake Computer and a fake channel", () => {
    expect(testing.createTestSdk).toBeTypeOf("function");
    expect(testing.createTestChat).toBeTypeOf("function");
    expect(testing.createFakeAdapter).toBeTypeOf("function");
    expect(testing.fakeComputerProvider).toBeTypeOf("function");
    expect(testing.fakeEmailProvider).toBeTypeOf("function");
  });

  it("peers only on the core (@botsdk/bot and @botsdk/client), never on a feature or an adapter", () => {
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    expect(names.filter((name) => name.startsWith("@botsdk/")).sort()).toEqual([
      "@botsdk/bot",
      "@botsdk/client",
    ]);
    const sources = readdirSync(join(packageRoot, "src"), { recursive: true }) as string[];
    for (const file of sources.filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(packageRoot, "src", file), "utf8");
      for (const [, imported] of source.matchAll(/from\s+["'](@botsdk\/[^/"']+)/g)) {
        expect(["@botsdk/bot", "@botsdk/client"], file).toContain(imported);
      }
    }
  });

  it("never reaches the repo's own packages (@ai-chat/*)", () => {
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    expect(names.filter((name) => name.startsWith("@ai-chat/"))).toEqual([]);
    const sources = readdirSync(join(packageRoot, "src"), { recursive: true }) as string[];
    for (const file of sources.filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(packageRoot, "src", file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']@ai-chat\//);
    }
  });
});
