import { drizzle } from "drizzle-orm/node-postgres";

import type { PostgresDatabase } from "../database";
import { relations } from "./relations";

export function createDb(env: { DATABASE_URL: string }, logger: Pick<Console, "error"> = console) {
  const db = drizzle(env.DATABASE_URL, { relations });
  // Postgres ending an idle connection (restart, failover) emits `error` on the pool. Unhandled,
  // that would crash the Host's process; the pool replaces the connection on the next query.
  db.$client.on("error", (error) => logger.error("An idle chat database connection failed", error));
  return db;
}

export type Database = ReturnType<typeof createDb>;

/**
 * The Drizzle instance over the `database` slot: over the Host's pool when it passed one, or over a
 * pool of the SDK's own, opened on first use, for a connection string.
 */
export function databaseOf(database: PostgresDatabase, logger: Pick<Console, "error"> = console) {
  if ("pool" in database) return drizzle({ client: database.pool, relations });
  return createDb({ DATABASE_URL: database.connectionString }, logger);
}
