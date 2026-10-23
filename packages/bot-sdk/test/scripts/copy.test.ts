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
    write(join(source, "plugins", "bot", "server", "index.ts"), "export const a = 1;");
    write(join(source, "plugins", "bot", "server", "index.test.ts"), "test");
    write(join(source, "plugins", "bot", "ui", "panel.tsx"), "export const Panel = 1;");
    write(join(source, "plugins", "models", "client", "index.ts"), "export const m = 1;");
    write(join(source, "plugins", "models", "ui", "keys.tsx"), "export const Keys = 1;");
    write(join(source, "extras", "trigger", "runner.ts"), "export const runner = 1;");
    write(join(source, "package.json"), "{}");
    write(join(source, "README.md"), "# readme");
    write(join(source, "NOTICE"), "Sim Studio");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("copies core, every plugin, ui, a root VERSION and no test files into an empty folder", () => {
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "VERSION"), "utf8")).toContain("abc1234def");
    expect(readFileSync(join(dest, "VERSION"), "utf8")).toContain("2026-10-09T10:00:00.000Z");
    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe(
      "export const Composer = 1;",
    );
    expect(readFileSync(join(dest, "ui", "theme.css"), "utf8")).toBe('@source ".";');
    expect(listFiles(dest)).toEqual([
      "NOTICE",
      "README.md",
      "VERSION",
      "core/client/index.ts",
      "core/server/index.ts",
      "extras/trigger/runner.ts",
      "package.json",
      "plugins/bot/server/index.ts",
      "plugins/bot/ui/panel.tsx",
      "plugins/models/client/index.ts",
      "plugins/models/ui/keys.tsx",
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
    expect(readFileSync(join(dest, "VERSION"), "utf8")).toContain("fff9999");
    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe("host edit");
  });

  it("copies extras once, so a Host's edits to its adapter survive updates", () => {
    copySdk(dest, { source, version });
    expect(readFileSync(join(dest, "extras", "trigger", "runner.ts"), "utf8")).toBe(
      "export const runner = 1;",
    );

    write(join(dest, "extras", "trigger", "runner.ts"), "host edit");
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "extras", "trigger", "runner.ts"), "utf8")).toBe("host edit");
  });

  it("replaces plugins server code on a second run but leaves an edited plugin ui untouched", () => {
    copySdk(dest, { source, version });

    write(join(dest, "plugins", "bot", "ui", "panel.tsx"), "host edit");
    write(join(dest, "plugins", "bot", "server", "removed.ts"), "stale");
    write(join(source, "plugins", "bot", "server", "index.ts"), "export const a = 2;");
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "plugins", "bot", "server", "index.ts"), "utf8")).toBe(
      "export const a = 2;",
    );
    expect(readFileSync(join(dest, "plugins", "bot", "ui", "panel.tsx"), "utf8")).toBe("host edit");
    expect(existsSync(join(dest, "plugins", "bot", "server", "removed.ts"))).toBe(false);
  });

  it("leaves a Host's own plugin folder alone, touching only the plugins the SDK ships", () => {
    write(join(dest, "plugins", "billing", "server", "index.ts"), "host plugin");

    copySdk(dest, { source, version });
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "plugins", "billing", "server", "index.ts"), "utf8")).toBe(
      "host plugin",
    );
  });

  it("checks each ui folder on its own: a missing one is copied while the others stay", () => {
    copySdk(dest, { source, version });

    write(join(dest, "ui", "chat", "composer.tsx"), "host edit");
    write(join(dest, "plugins", "bot", "ui", "panel.tsx"), "host edit");
    rmSync(join(dest, "plugins", "models", "ui"), { recursive: true });
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe("host edit");
    expect(readFileSync(join(dest, "plugins", "bot", "ui", "panel.tsx"), "utf8")).toBe("host edit");
    expect(readFileSync(join(dest, "plugins", "models", "ui", "keys.tsx"), "utf8")).toBe(
      "export const Keys = 1;",
    );

    rmSync(join(dest, "ui"), { recursive: true });
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "ui", "chat", "composer.tsx"), "utf8")).toBe(
      "export const Composer = 1;",
    );
    expect(readFileSync(join(dest, "plugins", "bot", "ui", "panel.tsx"), "utf8")).toBe("host edit");
  });

  it("copies package.json, README and NOTICE on every run", () => {
    copySdk(dest, { source, version });

    write(join(dest, "package.json"), "host edit");
    write(join(source, "README.md"), "# readme v2");
    write(join(source, "NOTICE"), "Sim Studio v2");
    copySdk(dest, { source, version });

    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("# readme v2");
    expect(readFileSync(join(dest, "NOTICE"), "utf8")).toBe("Sim Studio v2");
  });

  it("keeps each theme.css @source line resolving to a copied plugin ui folder", () => {
    write(join(source, "ui", "theme.css"), '@source ".";\n@source "../plugins/bot/ui";');

    copySdk(dest, { source, version });

    const css = readFileSync(join(dest, "ui", "theme.css"), "utf8");
    const targets = [...css.matchAll(/@source "([^"]+)"/g)].map((m) => join(dest, "ui", m[1]!));
    expect(targets).toHaveLength(2);
    for (const target of targets) expect(existsSync(target)).toBe(true);
  });

  it("never copies an eval folder, so the Memory eval stays in the canonical repo", () => {
    write(join(source, "core", "eval", "memory", "run.ts"), "eval");
    write(join(source, "plugins", "bot", "eval", "run.ts"), "eval");

    copySdk(dest, { source, version });

    expect(existsSync(join(dest, "core", "eval"))).toBe(false);
    expect(existsSync(join(dest, "plugins", "bot", "eval"))).toBe(false);
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
