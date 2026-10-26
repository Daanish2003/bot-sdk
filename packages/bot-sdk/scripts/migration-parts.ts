// The SDK's parts with migrations, in one list (spec #874): the core's, then each feature's that
// ships tables. `pnpm db:generate` runs this file: drizzle-kit for each part's config, then each
// part's `migrations.json` from the folders drizzle-kit wrote, one `{ name, sql }` per migration,
// oldest first. `migrate()` and `start()` read the JSON, which a bundler can import, never the
// folders. The test database, the evals and CI's drift check read the list too.
//
// Node runs this file directly (type stripping), so it imports only node: built-ins.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FeatureMigrations, Migration } from "../core/server/migrate";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each part: its id in the journal, the folder of its `migrations/` and `migrations.json`, and its
 * drizzle-kit config. The core's first.
 */
export const migrationParts = [
  { feature: "core", folder: "core/server", config: "drizzle.config.ts" },
  {
    feature: "memory",
    folder: "plugins/memory/server",
    config: "plugins/memory/drizzle.config.ts",
  },
  { feature: "mcp", folder: "plugins/mcp/server", config: "plugins/mcp/drizzle.config.ts" },
] as const;

/** A part's migrations as its JSON should hold them, read from its drizzle-kit folders. */
export function migrationsOf(folder: string): Migration[] {
  const migrations = join(SDK_ROOT, folder, "migrations");
  return readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(migrations, name, "migration.sql"), "utf8") }));
}

/** A part's migrations as it ships them: its `migrations.json`. */
export function shippedMigrations(folder: string): Migration[] {
  return JSON.parse(readFileSync(join(SDK_ROOT, folder, "migrations.json"), "utf8"));
}

/**
 * The shipped migrations of every SDK feature with tables (`migrate` adds the core's itself): a
 * database migrated with them has every table, so any feature may be enabled on it.
 */
export function sdkFeatureMigrations(): FeatureMigrations[] {
  return migrationParts
    .filter(({ feature }) => feature !== "core")
    .map(({ feature, folder }) => ({ feature, migrations: shippedMigrations(folder) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Its bin sits beside its entry point, wherever the package is installed.
  const entry = createRequire(join(SDK_ROOT, "package.json")).resolve("drizzle-kit");
  const drizzleKit = join(dirname(entry), "bin.cjs");
  for (const { folder, config } of migrationParts) {
    execFileSync(process.execPath, [drizzleKit, "generate", "--config", config], {
      cwd: SDK_ROOT,
      stdio: "inherit",
    });
    const json = `${JSON.stringify(migrationsOf(folder), null, 2)}\n`;
    writeFileSync(join(SDK_ROOT, folder, "migrations.json"), json);
  }
}
