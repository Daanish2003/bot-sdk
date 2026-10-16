// Copies the Bot SDK into a Host's source tree: `pnpm -F @ai-chat/bot-sdk copy <dest>`.
//
// - core/ is always replaced, and <dest>/VERSION records the commit and date copied.
// - plugins/ is replaced like core/, except each plugin's ui/ folder, which is the Host's once copied
//   (theme.css names those folders, so they keep the same layout under <dest>/).
// - ui/ and extras/ are copied only when their destination folder does not exist, so a Host's
//   edits survive updates.
// - package.json, README.md and NOTICE (the credit for ported code) are copied to <dest>/ on
//   every run (SDK-owned).
// - Tests and test helpers are never copied.
//
// Node runs this file directly (type stripping), so it imports only node: built-ins.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SdkVersion {
  commit: string;
  date: string;
}

export interface CopyOptions {
  /** The SDK folder to copy from. Defaults to this package. */
  source?: string;
  /** Where the commit and date come from. Defaults to `git rev-parse HEAD` and now. */
  version?: () => SdkVersion;
}

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT_FILES = ["package.json", "README.md", "NOTICE"];
const EXCLUDED_NAMES = new Set(["test", "tests", "testing", "__tests__", "node_modules", "eval"]);

function currentVersion(): SdkVersion {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: SDK_ROOT,
    encoding: "utf8",
  }).trim();
  return { commit, date: new Date().toISOString() };
}

function copyTree(from: string, to: string) {
  cpSync(from, to, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      return !EXCLUDED_NAMES.has(name) && !/\.test\./.test(name);
    },
  });
}

// core's barrels value-import plugins/, so a Host gets them too. Server and client code is replaced
// each run; a plugin's ui/ is copied only when absent, so Host edits survive.
function copyPlugins(source: string, target: string) {
  const from = join(source, "plugins");
  const to = join(target, "plugins");
  if (existsSync(to)) {
    for (const plugin of readdirSync(to, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      for (const entry of readdirSync(join(to, plugin.name))) {
        if (entry !== "ui") rmSync(join(to, plugin.name, entry), { recursive: true, force: true });
      }
    }
  }
  for (const plugin of readdirSync(from, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    for (const entry of readdirSync(join(from, plugin.name))) {
      const dest = join(to, plugin.name, entry);
      if (entry === "ui" && existsSync(dest)) continue;
      copyTree(join(from, plugin.name, entry), dest);
    }
  }
  // Drop plugin folders that no longer exist in the SDK or hold nothing.
  if (existsSync(to)) {
    for (const plugin of readdirSync(to, { withFileTypes: true })) {
      const dir = join(to, plugin.name);
      if (plugin.isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    }
  }
}

export function copySdk(dest: string, options: CopyOptions = {}): void {
  const source = resolve(options.source ?? SDK_ROOT);
  const target = resolve(dest);
  if (target === source) {
    throw new Error("Refusing to copy the Bot SDK onto itself");
  }
  const version = (options.version ?? currentVersion)();

  rmSync(join(target, "core"), { recursive: true, force: true });
  copyTree(join(source, "core"), join(target, "core"));
  writeFileSync(join(target, "VERSION"), `commit: ${version.commit}\ndate: ${version.date}\n`);

  copyPlugins(source, target);

  if (!existsSync(join(target, "ui"))) {
    copyTree(join(source, "ui"), join(target, "ui"));
  }
  // Optional adapters (extras/, such as the Trigger.dev runner) are the Host's to edit once copied.
  if (!existsSync(join(target, "extras"))) {
    copyTree(join(source, "extras"), join(target, "extras"));
  }

  for (const file of SDK_ROOT_FILES) {
    cpSync(join(source, file), join(target, file));
  }
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (!dest) {
    console.error("usage: pnpm -F @ai-chat/bot-sdk copy <dest>");
    process.exit(1);
  }
  // pnpm runs scripts from the package folder, so resolve against the folder the user ran it from.
  const target = resolve(process.env.INIT_CWD ?? process.cwd(), dest);
  copySdk(target);
  console.log(`Copied the Bot SDK to ${target}`);
}
