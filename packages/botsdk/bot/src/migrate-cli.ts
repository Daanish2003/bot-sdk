import { getTableConfig, isPgEnum } from "drizzle-orm/pg-core";

import type { BotSdkOptions } from "./create-chat";
import type { PostgresDatabase } from "./database";
import type { AnyFeature } from "./feature";
import { featureMigrations } from "./feature";
import { inTransaction, JOURNAL_DDL, migrate, pendingMigrations, withConnection } from "./migrate";
import type { PendingMigration } from "./migrate";
import { schema as coreSchema } from "./storage";

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
 * The statements that remove a feature's tables, the enums and sequences its `schema` declares
 * that no other table uses or owns, no enabled feature declares and the core doesn't define, and
 * its journal rows, so enabling it again
 * migrates it from its baseline. A sequence a table owns goes with it.
 * Throws for a feature in `enabled`: removal is for a disabled feature.
 */
function dropStatements(feature: AnyFeature, enabled: readonly AnyFeature[]): string {
  if (enabled.some(({ id }) => id === feature.id)) {
    throw new Error(`Feature "${feature.id}" is enabled: turn it off before removing its tables`);
  }
  const id = (text: string) => `"${text.replaceAll('"', '""')}"`;
  const qualified = (schema: string | undefined, name: string) =>
    quote(`${id(schema ?? "public")}.${id(name)}`);
  const tables = Object.values(feature.schema?.tables ?? {}).map((table) => {
    const { name, schema } = getTableConfig(table);
    return qualified(schema, name);
  });
  const enumsOf = ({ schema }: AnyFeature) =>
    Object.values(schema?.enums ?? {}).map((value) => qualified(value.schema, value.enumName));
  const sequencesOf = ({ schema }: AnyFeature) =>
    Object.values(schema?.sequences ?? {}).flatMap((value) =>
      value.seqName === undefined ? [] : [qualified(value.schema, value.seqName)],
    );
  // What an enabled feature also declares stays.
  const kept = new Set(enabled.flatMap((other) => [...enumsOf(other), ...sequencesOf(other)]));
  const enums = enumsOf(feature).filter((name) => !kept.has(name));
  const sequences = sequencesOf(feature).filter((name) => !kept.has(name));
  const coreEnums = (Object.values(coreSchema) as unknown[])
    .filter(isPgEnum)
    .map((value) => qualified(value.schema, value.enumName));
  return `do $$
declare
  listed text[] := array[${tables.join(", ")}]::text[];
  core_enums oid[] := array(
    select to_regtype(name_) from unnest(array[${coreEnums.join(", ")}]::text[]) as name_
    where to_regtype(name_) is not null
  );
  enums oid[];
  sequences oid[];
  entry oid;
begin
  -- By name: a cascade from an earlier table may already have dropped a later one.
  for i in 1 .. coalesce(array_length(listed, 1), 0) loop
    execute format('drop table if exists %s cascade', listed[i]);
  end loop;

  -- The declared enums and sequences that are still there.
  enums := array(
    select type_.oid from unnest(array[${enums.join(", ")}]::text[]) as name_
    join pg_type type_ on type_.oid = to_regtype(name_) and type_.typtype = 'e'
  );
  sequences := array(
    select class_.oid from unnest(array[${sequences.join(", ")}]::text[]) as name_
    join pg_class class_ on class_.oid = to_regclass(name_) and class_.relkind = 'S'
  );
  -- Only what no other table still uses or owns, and never a core enum.
  foreach entry in array sequences loop
    if not exists (
      select 1 from pg_depend where refobjid = entry and classid = 'pg_attrdef'::regclass
    ) and not exists (
      select 1 from pg_depend where objid = entry and classid = 'pg_class'::regclass
        and refclassid = 'pg_class'::regclass and deptype in ('a', 'i')
    ) then
      execute format('drop sequence %s', entry::regclass);
    end if;
  end loop;
  foreach entry in array enums loop
    if not entry = any(core_enums) and not exists (
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
  if (!config.default?.database) {
    throw new Error(
      "The config module must default-export the options you pass createBotSdk (with `database` and `features`), and may export `disabled` beside it",
    );
  }
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
