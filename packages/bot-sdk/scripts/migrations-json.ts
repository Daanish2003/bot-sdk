// Writes each part's `migrations.json` from the folder drizzle-kit generated beside it: one
// `{ name, sql }` per migration folder, oldest first (spec #874). `migrate()` and `start()` read the
// JSON, which a bundler can import, never the folders. `pnpm db:generate` runs it after drizzle-kit.
//
// Node runs this file directly (type stripping), so it imports only node: built-ins.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The folder of each part's `migrations/` and `migrations.json`: the core's, then each feature's. */
export const migrationParts = ["core/server", "plugins/memory/server", "plugins/mcp/server"];

/** A part's migrations as its JSON holds them, read from its drizzle-kit folders. */
export function migrationsOf(part: string): { name: string; sql: string }[] {
  const folder = join(SDK_ROOT, part, "migrations");
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(folder, name, "migration.sql"), "utf8") }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const part of migrationParts) {
    const json = `${JSON.stringify(migrationsOf(part), null, 2)}\n`;
    writeFileSync(join(SDK_ROOT, part, "migrations.json"), json);
  }
}
