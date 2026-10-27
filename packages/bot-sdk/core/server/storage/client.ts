import { drizzle } from "drizzle-orm/node-postgres";

import type { PostgresDatabase } from "../database";
import { relations } from "./relations";

export type Database = ReturnType<typeof databaseOf>;

/**
 * The Drizzle instance over the `database` slot: over the Host's pool when it passed one, or over a
 * pool of the SDK's own, opened on first use, for a connection string.
 */
export function databaseOf(database: PostgresDatabase, logger: Pick<Console, "error"> = console) {
  if ("pool" in database) return drizzle({ client: database.pool, relations });
  const db = drizzle(database.connectionString, { relations });
  // Postgres ending an idle connection (restart, failover) emits `error` on the pool. Unhandled,
  // that would crash the Host's process; the pool replaces the connection on the next query. A
  // Host's own pool is the Host's to listen on.
  db.$client.on("error", (error) =>
    logger.error("An idle botsdk database connection failed", error),
  );
  return db;
}
