import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { BlobStore } from "./blob/store";

/**
 * Kept in this file, with no runtime import from the rest of the SDK, so a Host's migrate script can load
 * it directly. The journal is `chat.__migrations`.
 */

/** Any fixed number: every `chat.migrate()` and `start()` on one database uses it. */
const MIGRATION_LOCK_ID = 727_770_001;

/**
 * The newest folder in `core/server/migrations`. A bundler can't read that folder at run time, so
 * `start()` compares against this name. A test keeps it equal to the folder listing.
 */
export const LATEST_MIGRATION = "20261023121149_assistant_contract";

function migrationsFolder() {
  // Only `migrate()` reads the folder, from a migrate script that runs the file unbundled. The
  // path is a variable so a bundler doesn't try to resolve the folder at build time.
  const folder = ["", "migrations"].join("./");
  return fileURLToPath(new URL(folder, import.meta.url));
}

/** Milliseconds for a migration folder's `yyyymmddhhmmss` prefix, as drizzle records them. */
function folderMillis(name: string) {
  const at = (start: number, length = 2) => Number(name.slice(start, start + length));
  return Date.UTC(at(0, 4), at(4) - 1, at(6), at(8), at(10), at(12));
}

/**
 * Creates the `chat` schema and `pg_trgm`, and then applies the bundled migrations. A
 * session advisory lock is held for the whole run, so concurrent runs queue up and only one applies.
 *
 * The run that applies the contract migration (#819) then deletes the assistant's bytes, under
 * `attachment/` and `generated-image/`: from `blobStore` when the Host has its own, else from
 * `chat.blob`.
 */
export async function migrate(
  databaseUrl: string,
  { blobStore }: { blobStore?: Pick<BlobStore, "delete"> } = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await createChatSchema(client);
    await createTrigramExtension(client);
    const assistantKeys = await assistantBlobKeys(client);
    await applyMigrations(drizzle({ client }), {
      migrationsFolder: migrationsFolder(),
      migrationsSchema: "chat",
      migrationsTable: "__migrations",
    });
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    if (assistantKeys) await deleteAssistantBlobs(client, assistantKeys, blobStore);
  } finally {
    await client.end();
  }
}

/**
 * The blob keys of the assistant's Attachments and Generated images, while either table exists
 * (the contract migration hasn't run), else null.
 */
async function assistantBlobKeys(client: pg.Client): Promise<string[] | null> {
  const keys: string[] = [];
  let present = false;
  for (const [table, prefix] of [
    ["attachment", "attachment/"],
    ["generated_image", "generated-image/"],
  ]) {
    const { rows } = await client.query<{ present: boolean }>(
      "select to_regclass($1) is not null as present",
      [`chat.${table}`],
    );
    if (!rows[0]?.present) continue;
    present = true;
    const ids = await client.query<{ id: string }>(`select id from chat.${table}`);
    keys.push(...ids.rows.map((row) => prefix + row.id));
  }
  return present ? keys : null;
}

/**
 * Deletes the assistant's bytes once the migration that dropped their rows has committed. Logged,
 * never thrown: a stray object costs storage but no data (ADR 0015).
 */
async function deleteAssistantBlobs(
  client: pg.Client,
  keys: string[],
  blobStore: Pick<BlobStore, "delete"> | undefined,
) {
  try {
    if (blobStore) await blobStore.delete(keys);
    else {
      await client.query(
        "delete from chat.blob where key like 'attachment/%' or key like 'generated-image/%'",
      );
    }
  } catch (error) {
    console.error("Deleting the assistant's blobs failed; their bytes may be stored", error);
  }
}

/** Only creates the schema when it is missing, so a Host may create it itself with fewer rights. */
async function createChatSchema(client: pg.Client) {
  const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'chat'");
  if (rowCount === 0) await client.query("create schema chat");
}

async function createTrigramExtension(client: pg.Client) {
  try {
    await client.query("create extension if not exists pg_trgm");
  } catch (cause) {
    throw new Error(
      "chat.migrate() needs the pg_trgm extension, and it could not be created. Install pg_trgm, or run migrate as a role allowed to create extensions.",
      { cause },
    );
  }
}

/**
 * Throws unless the journal has applied the bundled latest migration. Only reads, and holds no
 * lock: a run in progress is reported as behind until it finishes.
 */
export async function assertMigrated(databaseUrl: string): Promise<void> {
  const latest = folderMillis(LATEST_MIGRATION);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const journal = await client.query<{ present: boolean }>(
      "select to_regclass('chat.__migrations') is not null as present",
    );
    const applied = journal.rows[0]?.present
      ? await client.query<{ created_at: string | null }>(
          "select max(created_at) as created_at from chat.__migrations",
        )
      : undefined;
    const appliedUpTo = Number(applied?.rows[0]?.created_at ?? 0);
    if (appliedUpTo < latest) {
      throw new Error(
        "The chat schema is behind the bundled migrations: run chat.migrate() before start().",
      );
    }
  } finally {
    await client.end();
  }
}
