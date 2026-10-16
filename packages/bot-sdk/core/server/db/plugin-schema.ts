import { getTableName } from "drizzle-orm";
import type {
  AnyPgColumnBuilder,
  ExtraConfigColumn,
  PgEnum,
  PgTable,
  PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/** The core tables that plugins add columns and indexes to. */
export type CoreTableName = "conversation" | "message";

/** The index-callback argument: every column of the composed table, by key. */
export type IndexColumns<TColumns> = { [K in keyof TColumns]: ExtraConfigColumn };

/** What one plugin adds to one core table: Drizzle column builders, and indexes over the composed table. */
export type TableFields = {
  columns: Record<string, AnyPgColumnBuilder>;
  // A method, so a plugin's callback can name the core columns it indexes (method parameters are bivariant).
  indexes?(table: Partial<IndexColumns<Record<string, unknown>>>): PgTableExtraConfigValue[];
};

/**
 * A part's static schema module (the core's or a plugin's): its own tables and enums in plain
 * Drizzle, and the fields it adds to the core tables. `core/server/db/schema.ts` composes them.
 */
export type PluginSchema = {
  tables: Record<string, PgTable>;
  enums: Record<string, Pick<PgEnum<[string, ...string[]]>, "enumName">>;
  fields: Partial<Record<CoreTableName, TableFields>>;
};

export type NamedPluginSchema = { id: string; schema: PluginSchema };

type Named = { config: { name: string } };

/** The Postgres name of a column builder; a builder declared without one takes its key. */
function columnName(key: string, builder: AnyPgColumnBuilder) {
  return (builder as unknown as Named).config.name || key;
}

/** Records `name` as `owner`'s, throwing when another part already holds it. */
function claim(owners: Map<string, string>, name: string, owner: string, what: string) {
  const holder = owners.get(name);
  if (holder !== undefined && holder !== owner) {
    throw new Error(`Plugins "${holder}" and "${owner}" both declare the ${what} "${name}".`);
  }
  owners.set(name, owner);
}

/**
 * Throws when two parts declare the same table or enum, or the same column on a core table (by key
 * or by Postgres name). The core owns the names `conversation` and `message`. There is no override.
 */
export function assertNoClashes(schemas: readonly NamedPluginSchema[]) {
  const tables = new Map<string, string>([
    ["conversation", "core"],
    ["message", "core"],
  ]);
  const enums = new Map<string, string>();
  const columns = new Map<string, string>();
  for (const { id, schema } of schemas) {
    for (const table of Object.values(schema.tables)) {
      claim(tables, getTableName(table), id, "table");
    }
    for (const pgEnum of Object.values(schema.enums)) {
      claim(enums, pgEnum.enumName, id, "enum");
    }
    for (const [tableName, fields] of Object.entries(schema.fields)) {
      for (const [key, builder] of Object.entries(fields.columns)) {
        claim(columns, `${tableName}.${key}`, id, "column");
        const name = columnName(key, builder);
        if (name !== key) claim(columns, `${tableName}.${name}`, id, "column");
      }
    }
  }
}

/**
 * One index callback for a core table: every part's indexes, in order. Drizzle runs it when it
 * reads the table's config, and it throws when two parts declare the same index name.
 */
export function composeIndexes(table: CoreTableName, schemas: readonly NamedPluginSchema[]) {
  return (columns: Record<string, ExtraConfigColumn>): PgTableExtraConfigValue[] => {
    const owners = new Map<string, string>();
    return schemas.flatMap(({ id, schema }) => {
      const indexes = schema.fields[table]?.indexes?.(columns) ?? [];
      for (const index of indexes) {
        const name = (index as unknown as Partial<Named>).config?.name;
        if (name) claim(owners, name, id, `index on ${table}`);
      }
      return indexes;
    });
  };
}
