import type pg from "pg";

/**
 * Kept in this file, with no runtime import, so a Host's migrate script can load it directly, as
 * it does `migrate.ts`.
 */

/** A node-postgres-compatible pool: `pg`'s `Pool`, or a Neon serverless `Pool`. */
export type PostgresPool = pg.Pool;

/** The `database` slot: the Postgres the SDK keeps its data in, as `postgres()` makes it. */
export type PostgresDatabase = { connectionString: string } | { pool: PostgresPool };

/**
 * The `database` slot's value. With a connection string, the SDK opens its own pool on first use;
 * with the Host's `pool`, it queries through that pool and never ends it.
 */
export function postgres(options: PostgresDatabase): PostgresDatabase {
  return "pool" in options
    ? { pool: options.pool }
    : { connectionString: options.connectionString };
}
