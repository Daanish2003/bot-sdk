import { getTableConfig } from "drizzle-orm/pg-core";

import type { BotSdkOptions } from "./create-chat";
import type { PostgresDatabase } from "./database";
import type { AnyFeature } from "./feature";
import { featureMigrations } from "./feature";
import { inTransaction, JOURNAL_DDL, migrate, pendingMigrations, withConnection } from "./migrate";
import type { PendingMigration } from "./migrate";

/*
 * The `botsdk migrate` CLI's work (spec #874, #906), apart from loading the Host's config module:
 * what the bin calls once it has loaded it.
 */

/**
 * A Host's config module (`botsdk.config.ts`), as `botsdk migrate` loads it. Its default export is
 * the factory's options, the ones the Host passes `createBotSdk`: `migrate` reads their `database`
 * and `features`. It may also export `disabled`: features the Host once enabled, whose tables
 * `--drop <id>` may remove.
 */
export type MigrateConfigModule = {
  default: Pick<BotSdkOptions, "database" | "features">;
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
 * The statements that remove a feature's tables, the enums and sequences they used that nothing
 * else uses (its own: a sequence a table owns goes with it), and its journal rows, so enabling it
 * again migrates it from its baseline. Throws for a feature in `enabled`: removal is for a disabled
 * feature.
 */
function dropStatements(feature: AnyFeature, enabled: readonly AnyFeature[]): string {
  if (enabled.some(({ id }) => id === feature.id)) {
    throw new Error(`Feature "${feature.id}" is enabled: turn it off before removing its tables`);
  }
  const id = (text: string) => `"${text.replaceAll('"', '""')}"`;
  const tables = Object.values(feature.schema?.tables ?? {}).map((table) => {
    const { name, schema } = getTableConfig(table);
    return quote(`${id(schema ?? "public")}.${id(name)}`);
  });
  return `do $$
declare
  dropped regclass[] := array(
    select to_regclass(listed) from unnest(array[${tables.join(", ")}]::text[]) as listed
    where to_regclass(listed) is not null
  );
  enums oid[];
  sequences oid[];
  entry oid;
begin
  -- The enums the tables' columns (or arrays of them) are of, and the sequences their defaults use.
  select coalesce(array_agg(distinct element.oid), '{}') into enums
  from pg_attribute column_
  join pg_type type_ on type_.oid = column_.atttypid
  join pg_type element on element.typtype = 'e'
    and element.oid = case when type_.typcategory = 'A' then type_.typelem else type_.oid end
  where column_.attrelid = any(dropped) and column_.attnum > 0 and not column_.attisdropped;
  select coalesce(array_agg(distinct used.refobjid), '{}') into sequences
  from pg_attrdef default_
  join pg_depend used on used.classid = 'pg_attrdef'::regclass and used.objid = default_.oid
    and used.refclassid = 'pg_class'::regclass
  join pg_class sequence_ on sequence_.oid = used.refobjid and sequence_.relkind = 'S'
  where default_.adrelid = any(dropped);

  for i in 1 .. coalesce(array_length(dropped, 1), 0) loop
    execute format('drop table if exists %s cascade', dropped[i]);
  end loop;
  -- Only what no other table still uses: a type or sequence shared with the core stays.
  foreach entry in array sequences loop
    if exists (select 1 from pg_class where oid = entry) and not exists (
      select 1 from pg_depend where refobjid = entry and classid = 'pg_attrdef'::regclass
    ) then
      execute format('drop sequence %s', entry::regclass);
    end if;
  end loop;
  foreach entry in array enums loop
    if not exists (
      select 1 from pg_attribute column_ join pg_type type_ on type_.oid = column_.atttypid
      where not column_.attisdropped and (type_.oid = entry or type_.typelem = entry)
    ) then
      execute format('drop type %s', entry::regtype);
    end if;
  end loop;

  -- The journal is missing on a database that was never migrated.
  if to_regclass('botsdk.__migrations') is not null then
    delete from botsdk.__migrations where feature = ${quote(feature.id)};
  end if;
end $$;`;
}

/** The SQL `dropFeatureTables` runs, in one transaction: what `--drop --print` gives. */
export function dropSql(feature: AnyFeature, enabled: readonly AnyFeature[]): string {
  return ["begin;", dropStatements(feature, enabled), "commit;"].join("\n");
}

/** Runs `dropSql` on the database. It never runs on its own: only a Host's call asks for it. */
export async function dropFeatureTables(
  database: PostgresDatabase,
  feature: AnyFeature,
  enabled: readonly AnyFeature[] = [],
): Promise<void> {
  const statements = dropStatements(feature, enabled);
  await withConnection(database, (client) =>
    inTransaction(client, async () => {
      await client.query(statements);
    }),
  );
}

/**
 * Runs `botsdk migrate` over a loaded config module: migrates the default export's features, or
 * with `print` writes the pending SQL to `out`; with `drop` (the id of a feature the module exports
 * in `disabled`) removes its tables, or with `print` writes that SQL.
 */
export async function runMigrate(
  config: MigrateConfigModule,
  options: { print?: boolean; drop?: string },
  out: (text: string) => void,
): Promise<void> {
  const { database } = config.default;
  const features = config.default.features ?? [];
  if (options.drop !== undefined) {
    const feature = [...features, ...(config.disabled ?? [])].find(({ id }) => id === options.drop);
    if (!feature) {
      throw new Error(
        `No feature "${options.drop}" in the config's features or its disabled export`,
      );
    }
    if (options.print) out(dropSql(feature, features) + "\n");
    else await dropFeatureTables(database, feature, features);
    return;
  }
  if (options.print) {
    out(printSql(await pendingMigrations(database, featureMigrations(features))));
    return;
  }
  await migrate(database, featureMigrations(features));
}
