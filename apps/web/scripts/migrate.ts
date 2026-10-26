/// <reference types="node" />
/**
 * Migrates the app's database: Better Auth's tables first, then the Bot SDK's `botsdk` schema
 * through its `migrate()` (the core's tables and its features'), then drops the chat tables and
 * enums the app used to keep in `public`, and the SDK's schema from before the `botsdk` baseline
 * (#904). That data was development data only, so nothing is copied.
 *
 * `pnpm db:migrate` runs it with DATABASE_URL from Varlock; the e2e server runs it with its own URL.
 * Plain Node (type stripping), so imports keep their extensions.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { postgres } from "../../../packages/bot-sdk/core/server/database.ts";
import { migrate as migrateBotSdk } from "../../../packages/bot-sdk/core/server/migrate.ts";
import mcpMigrations from "../../../packages/bot-sdk/plugins/mcp/server/migrations.json" with { type: "json" };
import memoryMigrations from "../../../packages/bot-sdk/plugins/memory/server/migrations.json" with { type: "json" };

// Drizzle is the db package's dependency, not the web app's.
const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { drizzle } = dbRequire("drizzle-orm/node-postgres");
const { migrate } = dbRequire("drizzle-orm/node-postgres/migrator");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

// The chat tables and enums of the app's old `public` schema (the chat migrations before the SDK
// owned them), and the SDK's old `chat` schema. `IF EXISTS`, so re-running does nothing.
const DROP_OLD_CHAT_SCHEMA = `
  drop table if exists public.message_attachment, public.attachment_blob, public.attachment,
    public.shared_link, public.message, public.conversation,
    public.user_credentials, public.user_settings cascade;
  drop type if exists public.message_error_reason, public.message_role, public.message_status;
  drop schema if exists chat cascade;
`;

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

// The features the app may enable that have tables (`src/features.ts`, `src/services.ts`): Memory
// only runs with the Computer configured, but its tables are made either way.
await migrateBotSdk(postgres({ connectionString: databaseUrl }), [
  { feature: "memory", migrations: memoryMigrations },
  { feature: "mcp", migrations: mcpMigrations },
]);

const cleanup = drizzle(databaseUrl);
try {
  await cleanup.$client.query(DROP_OLD_CHAT_SCHEMA);
} finally {
  await cleanup.$client.end();
}
