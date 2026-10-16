import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

import { createDb, type Database } from "../../core/server/db/index";
import { migrate as migrateChatSchema } from "../../core/server/migrate";

const DEFAULT_TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/ai-chat_test";

/** The integration test database. Override with `TEST_DATABASE_URL`. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

/** Better Auth's tables are in `public`; the chat tables reference none of them. */
const authMigrationsFolder = fileURLToPath(new URL("../../../db/src/migrations", import.meta.url));

/** Creates the test database if it is missing, then applies every migration. */
export async function prepareTestDatabase() {
  await createDatabaseIfMissing(testDatabaseUrl);
  const db = createDb({ DATABASE_URL: testDatabaseUrl });
  try {
    await migrate(db, { migrationsFolder: authMigrationsFolder });
  } finally {
    await db.$client.end();
  }
  await migrateChatSchema(testDatabaseUrl);
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
  db ??= createDb({ DATABASE_URL: testDatabaseUrl });
  return db;
}

export async function closeTestDb() {
  await db?.$client.end();
  db = undefined;
}

/**
 * Empties every table in `public` and in `chat`, except the chat migration journal: it records
 * what has been applied, so it must survive.
 */
export async function truncateAllTables(database: Database) {
  const { rows } = await database.execute<{ schemaname: string; tablename: string }>(
    sql`select schemaname, tablename from pg_tables
      where schemaname = 'public' or (schemaname = 'chat' and tablename <> '__migrations')`,
  );
  if (rows.length === 0) return;
  const tables = rows
    .map(({ schemaname, tablename }) => `"${schemaname}"."${tablename}"`)
    .join(", ");
  await database.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
