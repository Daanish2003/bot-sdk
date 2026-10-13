// Copies the Chat SDK into a Host's source tree: `pnpm -F @ai-chat/chat-sdk copy <dest>`.
//
// - core/ is always replaced, and core/VERSION records the commit and date copied.
// - ui/ and extras/ are copied only when their destination folder does not exist, so a Host's
//   edits survive updates.
// - package.json and README.md are copied to <dest>/ on every run (SDK-owned).
// - Tests and test helpers are never copied.
//
// Node runs this file directly (type stripping), so it imports only node: built-ins.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
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
const SDK_ROOT_FILES = ["package.json", "README.md"];
const EXCLUDED_NAMES = new Set(["test", "tests", "testing", "__tests__", "node_modules"]);

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

export function copySdk(dest: string, options: CopyOptions = {}): void {
  const source = resolve(options.source ?? SDK_ROOT);
  const target = resolve(dest);
  if (target === source) {
    throw new Error("Refusing to copy the Chat SDK onto itself");
  }
  const version = (options.version ?? currentVersion)();

  rmSync(join(target, "core"), { recursive: true, force: true });
  copyTree(join(source, "core"), join(target, "core"));
  writeFileSync(
    join(target, "core", "VERSION"),
    `commit: ${version.commit}\ndate: ${version.date}\n`,
  );

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
    console.error("usage: pnpm -F @ai-chat/chat-sdk copy <dest>");
    process.exit(1);
  }
  // pnpm runs scripts from the package folder, so resolve against the folder the user ran it from.
  const target = resolve(process.env.INIT_CWD ?? process.cwd(), dest);
  copySdk(target);
  console.log(`Copied the Chat SDK to ${target}`);
}
