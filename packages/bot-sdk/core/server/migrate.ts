import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { PostgresDatabase } from "./database";
import type { BlobStore } from "./storage";
import type { Logger } from "./create-chat";

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
 * The contract migration (#819) deletes every `attachment/` and `generated-image/` byte in
 * `chat.blob` itself. With the Host's own `blobStore`, the run that applies it then deletes the
 * bytes the dropped `chat.attachment` and `chat.generated_image` rows pointed at from that store
 * too, by the keys those rows held. `BlobStore` can't list keys, so that part is best effort (ADR 0015): a store object with
 * no row, or one left by a run that stopped before its deletes, stays.
 */
export async function migrate(
  database: PostgresDatabase,
  { blobStore, logger = console }: { blobStore?: Pick<BlobStore, "delete">; logger?: Logger } = {},
): Promise<void> {
  const assistantKeys = await withConnection(database, async (client) => {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await createChatSchema(client);
    await createTrigramExtension(client);
    const keys = blobStore ? await assistantBlobKeys(client) : [];
    await applyMigrations(drizzle({ client }), {
      migrationsFolder: migrationsFolder(),
      migrationsSchema: "chat",
      migrationsTable: "__migrations",
    });
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    return keys;
  });
  // Once the connection is back: the deletes can take a while on the Host's store.
  if (blobStore) await deleteAssistantBlobs(assistantKeys, blobStore, logger);
}

/**
 * Runs `use` on one connection of `database`, for work that needs a single session (an advisory
 * lock): its own client for a connection string, or a client checked out of the Host's pool,
 * which goes back to the pool afterwards, or is destroyed when `use` throws.
 */
async function withConnection<T>(
  database: PostgresDatabase,
  use: (client: Connection) => Promise<T>,
): Promise<T> {
  if ("pool" in database) {
    const client = await database.pool.connect();
    let result: T;
    try {
      result = await use(client);
    } catch (error) {
      // Destroyed, not returned: the session may still hold a lock the failure left taken.
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    client.release();
    return result;
  }
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** A connection `withConnection` lends. */
type Connection = pg.Client | pg.PoolClient;

/**
 * The blob keys of the assistant's Attachments and Generated images, while their tables exist
 * (the contract migration hasn't run); none after.
 */
async function assistantBlobKeys(client: Connection): Promise<string[]> {
  const keys: string[] = [];
  for (const [table, prefix] of [
    ["attachment", "attachment/"],
    ["generated_image", "generated-image/"],
  ]) {
    const { rows } = await client.query<{ present: boolean }>(
      "select to_regclass($1) is not null as present",
      [`chat.${table}`],
    );
    if (!rows[0]?.present) continue;
    const ids = await client.query<{ id: string }>(`select id from chat.${table}`);
    keys.push(...ids.rows.map((row) => prefix + row.id));
  }
  return keys;
}

/**
 * Deletes the assistant's bytes from the Host's store once the migration that dropped their rows
 * has committed, one key at a time so one failure skips only its own key. Logged to the Host's
 * logger, never thrown: a stray object costs storage but no data (ADR 0015).
 */
async function deleteAssistantBlobs(
  keys: string[],
  blobStore: Pick<BlobStore, "delete">,
  logger: Logger,
) {
  let failed = 0;
  for (const key of keys) {
    try {
      await blobStore.delete([key]);
    } catch (error) {
      failed += 1;
      if (failed === 1) logger.error("Deleting an assistant blob failed", error);
    }
  }
  if (failed > 0) {
    logger.error(`${failed} of the assistant's ${keys.length} blobs are still stored`);
  }
}

/** Only creates the schema when it is missing, so a Host may create it itself with fewer rights. */
async function createChatSchema(client: Connection) {
  const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'chat'");
  if (rowCount === 0) await client.query("create schema chat");
}

async function createTrigramExtension(client: Connection) {
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
export async function assertMigrated(database: PostgresDatabase): Promise<void> {
  const latest = folderMillis(LATEST_MIGRATION);
  await withConnection(database, async (client) => {
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
  });
}
