import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copySdk } from "../../scripts/copy";

const version = () => ({ commit: "abc1234def", date: "2026-10-09T10:00:00.000Z" });

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

describe("copySdk", () => {
  let tmp: string;
  let source: string;
  let dest: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "copy-sdk-"));
    source = join(tmp, "sdk");
    dest = join(tmp, "host", "chat-sdk");

    write(join(source, "core", "server", "index.ts"), "export const server = 1;");
    write(join(source, "core", "server", "index.test.ts"), "test");
    write(join(source, "core", "server", "testing", "fake.ts"), "fake");
    write(join(source, "core", "client", "index.ts"), "export const client = 1;");
    write(join(source, "core", "client", "tests", "x.ts"), "x");
    write(join(source, "ui", "chat", "composer.tsx"), "export const Composer = 1;");
    write(join(source, "ui", "theme.css"), '@source ".";');
    write(join(source, "ui", "chat", "composer.test.tsx"), "test");
    write(join(source, "package.json"), "{}");
    write(join(source, "README.md"), "# readme");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("copies core with VERSION, ui, and no test files into an empty folder", () => {
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "core", "VERSION"), "utf8")).toContain("abc1234def");
    expect(readFileSync(join(dest, "core", "VERSION"), "utf8")).toContain(
      "2026-10-09T10:00:00.000Z",
    );
    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe(
      "export const Composer = 1;",
    );
    expect(readFileSync(join(dest, "ui", "theme.css"), "utf8")).toBe('@source ".";');
    expect(listFiles(dest)).toEqual([
      "README.md",
      "core/VERSION",
      "core/client/index.ts",
      "core/server/index.ts",
      "package.json",
      "ui/chat/composer.tsx",
      "ui/theme.css",
    ]);
  });

  it("replaces core on a second run and leaves an edited ui untouched", () => {
    copySdk(dest, { source, version });

    write(join(dest, "ui", "chat", "composer.tsx"), "host edit");
    rmSync(join(source, "core", "client", "index.ts"));
    write(join(source, "core", "server", "index.ts"), "export const server = 2;");
    copySdk(dest, {
      source,
      version: () => ({ commit: "fff9999", date: "2026-10-10T10:00:00.000Z" }),
    });

    expect(readFileSync(join(dest, "core", "server", "index.ts"), "utf8")).toBe(
      "export const server = 2;",
    );
    expect(existsSync(join(dest, "core", "client", "index.ts"))).toBe(false);
    expect(readFileSync(join(dest, "core", "VERSION"), "utf8")).toContain("fff9999");
    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe("host edit");
  });

  it("gives a Host core and ui only, so the shared e2e scenarios never reach it", () => {
    const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    // The check is only meaningful while the scenarios exist in the canonical repo.
    expect(existsSync(join(sdkRoot, "test", "e2e", "scenarios.ts"))).toBe(true);

    copySdk(dest, { version });

    const scenarioFiles = listFiles(dest).filter((file) =>
      /(^|\/)(test|e2e)\/|scenarios\.ts$|\.test\./.test(file),
    );
    expect(scenarioFiles).toEqual([]);
  });
});
