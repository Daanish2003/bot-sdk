/// <reference types="node" />
/**
 * Migrates the app's database: Better Auth's tables first, then the Bot SDK's `chat` schema
 * through its `migrate()`, then drops the chat tables and enums the app used to keep in `public`.
 * That data was development data only, so nothing is copied.
 *
 * `pnpm db:migrate` runs it with DATABASE_URL from Varlock; the e2e server runs it with its own URL.
 * Plain Node (type stripping), so imports keep their extensions.
 */
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { postgres } from "../../../packages/bot-sdk/core/server/database.ts";
import { migrate as migrateChatSchema } from "../../../packages/bot-sdk/core/server/migrate.ts";

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

/**
 * `blobStoreOf` from the app's `S3_*` variables, or undefined when none is set. It loads the SDK,
 * whose extensionless imports plain Node resolves through the hook below (as in `rotate-keys.ts`).
 */
async function hostBlobStore() {
  if (!Object.keys(process.env).some((name) => name.startsWith("S3_") && process.env[name])) {
    return undefined;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!specifier.startsWith(".")) throw error;
        for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // Try the next form of the path.
          }
        }
        throw error;
      }
    },
  });
  const { blobStoreOf } = await import("../src/blob-store.ts");
  return blobStoreOf(process.env);
}

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

// The app's S3 file store, when set, so the contract migration (#819) deletes the assistant's bytes
// from it as well.
await migrateChatSchema(postgres({ connectionString: databaseUrl }), {
  blobStore: await hostBlobStore(),
});

const cleanup = drizzle(databaseUrl);
try {
  await cleanup.$client.query(DROP_OLD_CHAT_SCHEMA);
} finally {
  await cleanup.$client.end();
}
