import { getTableConfig } from "drizzle-orm/pg-core";

import type { PostgresDatabase } from "./database";
import type { AnyFeature } from "./feature";
import { featureMigrations } from "./feature";
import { JOURNAL_DDL, migrate, pendingMigrations, withConnection } from "./migrate";
import type { PendingMigration } from "./migrate";

/*
 * The `botsdk migrate` CLI's work (spec #874, #906), apart from loading the Host's config: what the
 * bin calls once it has the config's `database` and `features`.
 */

/** What the Host's config module default-exports: the factory's `database` and `features`. */
export type MigrateConfig = {
  database: PostgresDatabase;
  /** The enabled features: what `migrate` applies. */
  features?: readonly AnyFeature[];
  /** Features the Host once enabled, which `--drop` may remove the tables of. */
  disabled?: readonly AnyFeature[];
};

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * The SQL that does what `migrate` would: the schema, the extension and the journal, then each
 * pending migration with its journal row, in its own transaction. For a Host that applies SQL with
 * its own tool.
 */
export function printSql(pending: readonly PendingMigration[]): string {
  const prelude = [
    "create schema if not exists botsdk;",
    "create extension if not exists pg_trgm;",
    `${JOURNAL_DDL};`,
  ].join("\n");
  const steps = pending.map(
    ({ feature, name, sql }) =>
      `-- ${feature}/${name}\nbegin;\n${sql.trim()}\n;\n` +
      `insert into botsdk.__migrations (feature, migration) values (${quote(feature)}, ${quote(name)});\ncommit;`,
  );
  return [prelude, ...steps].join("\n\n") + "\n";
}

/**
 * The SQL that removes a feature's tables and its journal rows, so enabling it again migrates it
 * from its baseline. Throws for a feature in `enabled`: removal is for a disabled feature.
 */
export function dropSql(feature: AnyFeature, enabled: readonly AnyFeature[]): string {
  if (enabled.some(({ id }) => id === feature.id)) {
    throw new Error(`Feature "${feature.id}" is enabled: turn it off before removing its tables`);
  }
  const drops = Object.values(feature.schema?.tables ?? {}).map((table) => {
    const { name, schema } = getTableConfig(table);
    const id = (text: string) => `"${text.replaceAll('"', '""')}"`;
    return `drop table if exists ${id(schema ?? "public")}.${id(name)} cascade;`;
  });
  return [
    "begin;",
    ...drops,
    // The journal is missing on a database that was never migrated.
    `do $$ begin if to_regclass('botsdk.__migrations') is not null then delete from botsdk.__migrations where feature = ${quote(feature.id)}; end if; end $$;`,
    "commit;",
  ].join("\n");
}

/** Runs `dropSql` on the database. It never runs on its own: only a Host's call asks for it. */
export async function dropFeatureTables(
  database: PostgresDatabase,
  feature: AnyFeature,
  enabled: readonly AnyFeature[] = [],
): Promise<void> {
  const sql = dropSql(feature, enabled);
  await withConnection(database, async (client) => {
    try {
      await client.query(sql);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Runs `botsdk migrate` over a loaded config: migrates, or with `print` writes the pending SQL to
 * `out`; with `drop` (a feature id of the config's `disabled`) removes its tables, or with `print`
 * writes that SQL.
 */
export async function runMigrate(
  config: MigrateConfig,
  options: { print?: boolean; drop?: string },
  out: (text: string) => void,
): Promise<void> {
  const features = config.features ?? [];
  if (options.drop !== undefined) {
    const feature = [...features, ...(config.disabled ?? [])].find(({ id }) => id === options.drop);
    if (!feature)
      throw new Error(`No feature "${options.drop}" in the config's features or disabled`);
    if (options.print) out(dropSql(feature, features) + "\n");
    else await dropFeatureTables(config.database, feature, features);
    return;
  }
  if (options.print) {
    out(printSql(await pendingMigrations(config.database, featureMigrations(features))));
    return;
  }
  await migrate(config.database, featureMigrations(features));
}
