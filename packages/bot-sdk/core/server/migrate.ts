import pg from "pg";

import type { PostgresDatabase } from "./database";
import coreMigrations from "./migrations.json" with { type: "json" };

/**
 * Kept in this file, with no runtime import from the rest of the SDK but data, so a Host's migrate
 * script can load it directly. The journal is `botsdk.__migrations`, one row per applied
 * migration, keyed by its part (`core` or a feature's id) and its name (spec #874).
 */

/** Any fixed number: every `chat.migrate()` on one database uses it. */
const MIGRATION_LOCK_ID = 727_770_001;

/** One SQL migration of the core or a feature. Its `name` is unique within its part. */
export type Migration = { name: string; sql: string };

/** A feature's migrations, oldest first, under its id. */
export type FeatureMigrations = { feature: string; migrations: readonly Migration[] };

/** A migration the journal doesn't have yet, with its part. */
export type PendingMigration = Migration & { feature: string };

/** The core's migrations: the core's tables, which every Host has, and features may reference. */
const core: FeatureMigrations = { feature: "core", migrations: coreMigrations };

/**
 * Creates the `botsdk` schema and `pg_trgm`, then applies what the journal lacks: the core's
 * migrations, then each feature's in the order given, each in its own transaction with its journal
 * row. A session advisory lock is held for the whole run, so concurrent runs queue up and only one
 * applies. A feature left out keeps its tables and rows.
 */
export async function migrate(
  database: PostgresDatabase,
  features: readonly FeatureMigrations[] = [],
): Promise<void> {
  await withConnection(database, async (client) => {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await createSchema(client);
    await createTrigramExtension(client);
    await client.query(`create table if not exists botsdk.__migrations (
      feature text not null,
      migration text not null,
      applied_at timestamp with time zone not null default clock_timestamp(),
      primary key (feature, migration)
    )`);
    for (const pending of pendingIn(await journalOf(client), features)) {
      await client.query("begin");
      try {
        await client.query(pending.sql);
        await client.query("insert into botsdk.__migrations (feature, migration) values ($1, $2)", [
          pending.feature,
          pending.name,
        ]);
        await client.query("commit");
      } catch (cause) {
        await client.query("rollback");
        throw new Error(`Migration ${pending.name} of "${pending.feature}" failed`, { cause });
      }
    }
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  });
}

/**
 * What `migrate` would apply now for these features, in order: for a Host that applies the SQL
 * with its own tools. Only reads.
 */
export async function pendingMigrations(
  database: PostgresDatabase,
  features: readonly FeatureMigrations[] = [],
): Promise<PendingMigration[]> {
  return pendingIn(await withConnection(database, journalOf), features);
}

/** The core's and the features' migrations that `applied` lacks, the core's first. */
function pendingIn(
  applied: ReadonlySet<string>,
  features: readonly FeatureMigrations[],
): PendingMigration[] {
  return [core, ...features].flatMap(({ feature, migrations }) =>
    migrations
      .filter(({ name }) => !applied.has(journalKey(feature, name)))
      .map((migration) => ({ ...migration, feature })),
  );
}

const journalKey = (feature: string, migration: string) => `${feature}/${migration}`;

/** The journal's rows as `journalKey`s: none before the first `migrate`. */
async function journalOf(client: Connection): Promise<Set<string>> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass('botsdk.__migrations') is not null as present",
  );
  if (!rows[0]?.present) return new Set();
  const journal = await client.query<{ feature: string; migration: string }>(
    "select feature, migration from botsdk.__migrations",
  );
  return new Set(journal.rows.map((row) => journalKey(row.feature, row.migration)));
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

/** Only creates the schema when it is missing, so a Host may create it itself with fewer rights. */
async function createSchema(client: Connection) {
  const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'botsdk'");
  if (rowCount === 0) await client.query("create schema botsdk");
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
 * Throws unless the journal has every migration of the core and of these (the enabled) features.
 * Only reads, and holds no lock: a run in progress is reported as behind until it finishes.
 */
export async function assertMigrated(
  database: PostgresDatabase,
  features: readonly FeatureMigrations[] = [],
): Promise<void> {
  // Thrown after the connection is back, so a behind schema doesn't cost the Host's pool one.
  const behind = (await pendingMigrations(database, features))[0]?.feature;
  if (behind === "core") {
    throw new Error(
      "The `botsdk` schema is behind the bundled migrations: run chat.migrate() before start().",
    );
  }
  if (behind !== undefined) {
    throw new Error(
      `Feature "${behind}" is behind its migrations: run chat.migrate() with it enabled before start().`,
    );
  }
}
