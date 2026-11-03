import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

import { databaseOf, type Database } from "@botsdk/bot/storage";
import { postgres } from "@botsdk/bot/database";
import { migrate as migrateBotSdk } from "@botsdk/bot/migrate";
import { sdkFeatureMigrations } from "../scripts/migration-parts";

const DEFAULT_TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/ai-chat_test";

// `setup.ts` repoints TEST_DATABASE_URL at the worker's database, and this module may be evaluated
// again in the same worker, so the configured URL is kept in TEST_DATABASE_BASE_URL.
/** The configured database (`TEST_DATABASE_URL`): migrated once, then copied for each worker. */
const baseTestDatabaseUrl = (process.env.TEST_DATABASE_BASE_URL ??=
  process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);

// Global setup evaluates this module first, in the main process, and the workers it starts inherit
// the environment, so every worker of one run sees the same id. Another run against the same
// TEST_DATABASE_URL gets its own id, so neither drops the other's copies.
/** Names this test run's worker copies. */
const runId = (process.env.TEST_DATABASE_RUN_ID ??= randomBytes(3).toString("hex"));

/** `<test database>_r<run>_w`: the prefix of this run's worker copies. */
const workerPrefix = `${databaseName(baseTestDatabaseUrl)}_r${runId}_w`;

/** `<test database>_r<run>_w<n>`: worker n's copy of the migrated test database. */
function workerDatabaseUrl(poolId: number | string) {
  const url = new URL(baseTestDatabaseUrl);
  url.pathname = `/${workerPrefix}${poolId}`;
  return url.toString();
}

/**
 * The integration test database: this worker's copy (`VITEST_POOL_ID`), or outside a worker the
 * configured one.
 */
export const testDatabaseUrl = process.env.VITEST_POOL_ID
  ? workerDatabaseUrl(process.env.VITEST_POOL_ID)
  : baseTestDatabaseUrl;

/** Better Auth's tables are in `public`; the SDK's tables reference none of them. */
const authMigrationsFolder = fileURLToPath(new URL("../../db/src/migrations", import.meta.url));

/**
 * Creates the configured test database if it is missing and applies every migration (the core's and
 * every SDK feature's), then makes one copy of it per worker (`<test database>_r<run>_w1` …
 * `_w<workers>`).
 */
export async function prepareTestDatabases(workers: number) {
  await createDatabaseIfMissing(baseTestDatabaseUrl);
  const db = databaseOf(postgres({ connectionString: baseTestDatabaseUrl }));
  try {
    await migrate(db, { migrationsFolder: authMigrationsFolder });
  } finally {
    await db.$client.end();
  }
  // Every SDK feature's tables, so any test may enable any feature.
  await migrateBotSdk(postgres({ connectionString: baseTestDatabaseUrl }), sdkFeatureMigrations());

  const template = quoteIdentifier(databaseName(baseTestDatabaseUrl));
  const client = await serverClient(baseTestDatabaseUrl);
  try {
    for (let poolId = 1; poolId <= workers; poolId++) {
      const name = quoteIdentifier(databaseName(workerDatabaseUrl(poolId)));
      await client.query(`create database "${name}" template "${template}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Drops this run's worker copies and any scratch database its tests left behind
 * (`<test database>_r<run>_w<n>_<suffix>`). Other runs' copies are theirs to drop.
 */
export async function dropWorkerDatabases() {
  const prefix = workerPrefix;
  const client = await serverClient(baseTestDatabaseUrl);
  try {
    const { rows } = await client.query<{ datname: string }>("select datname from pg_database");
    for (const { datname } of rows) {
      if (!datname.startsWith(prefix) || !/^\d+(_.+)?$/.test(datname.slice(prefix.length)))
        continue;
      await client.query(`drop database "${quoteIdentifier(datname)}" with (force)`);
    }
  } finally {
    await client.end();
  }
}

async function createDatabaseIfMissing(url: string) {
  const name = databaseName(url);
  const client = await serverClient(url);
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      await client.query(`create database "${quoteIdentifier(name)}"`);
    }
  } finally {
    await client.end();
  }
}

function databaseName(url: string) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function quoteIdentifier(name: string) {
  return name.replaceAll('"', '""');
}

/** A connection to the server's `postgres` database, for creating and dropping databases. */
async function serverClient(url: string) {
  const server = new URL(url);
  server.pathname = "/postgres";
  const client = new Client({ connectionString: server.toString() });
  await client.connect();
  return client;
}

/**
 * URL of an empty database named `<test database>_<suffix>`, replacing any leftover one. For tests
 * that migrate from scratch; `dropScratchDatabase` removes it.
 */
export async function freshDatabaseUrl(suffix: string): Promise<string> {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${databaseName(testDatabaseUrl)}_${suffix}`;
  const name = databaseName(url.toString());
  const client = await serverClient(testDatabaseUrl);
  try {
    await client.query(`drop database if exists "${quoteIdentifier(name)}" with (force)`);
    await client.query(`create database "${quoteIdentifier(name)}"`);
  } finally {
    await client.end();
  }
  return url.toString();
}

/** Drops a database made by `freshDatabaseUrl`. */
export async function dropScratchDatabase(url: string) {
  const client = await serverClient(testDatabaseUrl);
  try {
    await client.query(
      `drop database if exists "${quoteIdentifier(databaseName(url))}" with (force)`,
    );
  } finally {
    await client.end();
  }
}

let db: Database | undefined;

/** One connection pool to the test database per test file. */
export function getTestDb(): Database {
  db ??= databaseOf(postgres({ connectionString: testDatabaseUrl }));
  return db;
}

/** Forgets the pool first: one that can't close in time must not be handed to the next file. */
export async function closeTestDb() {
  const closing = db;
  db = undefined;
  await closing?.$client.end();
}

/** How long one try of the truncate queues for its locks, and how long it keeps trying. */
const truncateLockWait = "1s";
const truncateTriesMs = 8_000;

/** Whether `error` is Postgres's `lock_not_available`, on the error itself or drizzle's wrapper. */
const isLockTimeout = (error: unknown) => {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  return (code ?? cause?.code) === "55P03";
};

/**
 * Empties every table in `public` and in `botsdk`, except the SDK's migration journal: it records
 * what has been applied, so it must survive. A job an earlier test's stopped runner gave up on can
 * still hold a transaction. A truncate waiting for it would hold up
 * every new read of those tables, the ones that job waits on too, and Postgres sees no deadlock in
 * that. So each try gives up its place in the queue soon, which lets the job finish.
 */
export async function truncateAllTables(database: Database) {
  const { rows } = await database.execute<{ schemaname: string; tablename: string }>(
    sql`select schemaname, tablename from pg_tables
      where schemaname = 'public' or (schemaname = 'botsdk' and tablename <> '__migrations')`,
  );
  if (rows.length === 0) return;
  const tables = rows
    .map(({ schemaname, tablename }) => `"${schemaname}"."${tablename}"`)
    .join(", ");
  const deadline = Date.now() + truncateTriesMs;
  for (;;) {
    try {
      await database.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${truncateLockWait}'`));
        await tx.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
      });
      return;
    } catch (error) {
      if (!isLockTimeout(error) || Date.now() >= deadline) throw error;
    }
  }
}
