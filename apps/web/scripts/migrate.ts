/// <reference types="node" />
/**
 * Migrates the app's database: Better Auth's tables first, then the Bot SDK's `botsdk` schema for
 * the features `botsdk.config.ts` lists, the config `src/services.ts` builds the SDK from. It runs
 * what `botsdk migrate` runs, over the same module.
 *
 * `pnpm db:migrate` runs it with DATABASE_URL from Varlock; the e2e server runs it with its own URL.
 * Plain Node (type stripping): the config and the SDK import without extensions, so the SDK's
 * resolve hook is registered before they load.
 */
import { createRequire, register } from "node:module";
import { fileURLToPath } from "node:url";

register("@botsdk/bot/ts-extensionless", import.meta.url);

// Drizzle is the db package's dependency, not the web app's.
const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { drizzle } = dbRequire("drizzle-orm/node-postgres");
const { migrate } = dbRequire("drizzle-orm/node-postgres/migrator");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

const db = drizzle(databaseUrl);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../../packages/db/src/migrations", import.meta.url),
    ),
  });
} finally {
  await db.$client.end();
}

const { runMigrate } = await import("@botsdk/bot/migrate-cli");
await runMigrate(await import("../botsdk.config.ts"), {}, (text) => process.stdout.write(text));
