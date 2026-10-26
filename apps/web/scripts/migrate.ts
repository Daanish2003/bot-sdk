/// <reference types="node" />
/**
 * Migrates the app's database: Better Auth's tables first, then the Bot SDK's `botsdk` schema
 * through its `migrate()`, then drops the chat tables and enums the app used to keep in `public`.
 * That data was development data only, so nothing is copied.
 *
 * `pnpm db:migrate` runs it with DATABASE_URL from Varlock; the e2e server runs it with its own URL.
 * Plain Node (type stripping), so imports keep their extensions.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { migrate as migrateBotSdk } from "../../../packages/bot-sdk/core/server/migrate.ts";

// Drizzle is the db package's dependency, not the web app's.
const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { drizzle } = dbRequire("drizzle-orm/node-postgres");
const { migrate } = dbRequire("drizzle-orm/node-postgres/migrator");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

// The chat tables and enums of the app's old `public` schema (the chat migrations before the SDK
// owned them). `IF EXISTS`, so re-running does nothing.
const DROP_OLD_CHAT_SCHEMA = `
  drop table if exists public.message_attachment, public.attachment_blob, public.attachment,
    public.shared_link, public.message, public.conversation,
    public.user_credentials, public.user_settings cascade;
  drop type if exists public.message_error_reason, public.message_role, public.message_status;
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

await migrateBotSdk(databaseUrl);

const cleanup = drizzle(databaseUrl);
try {
  await cleanup.$client.query(DROP_OLD_CHAT_SCHEMA);
} finally {
  await cleanup.$client.end();
}
