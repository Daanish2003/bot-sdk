import { getTableName } from "drizzle-orm";
import type { PgEnum, PgTable } from "drizzle-orm/pg-core";

/**
 * A part's static schema module (the core's or a plugin's): its own tables and enums in plain
 * Drizzle. `storage/schema.ts` composes them.
 */
export type PluginSchema = {
  tables: Record<string, PgTable>;
  enums: Record<string, Pick<PgEnum<[string, ...string[]]>, "enumName">>;
};

export type NamedPluginSchema = { id: string; schema: PluginSchema };

/** Records `name` as `owner`'s, throwing when another part already holds it. */
function claim(owners: Map<string, string>, name: string, owner: string, what: string) {
  const holder = owners.get(name);
  if (holder !== undefined && holder !== owner) {
    throw new Error(`Plugins "${holder}" and "${owner}" both declare the ${what} "${name}".`);
  }
  owners.set(name, owner);
}

/**
 * Throws when two parts declare the same table or enum. The core owns the names `conversation` and
 * `message`. There is no override.
 */
export function assertNoClashes(schemas: readonly NamedPluginSchema[]) {
  const tables = new Map<string, string>([
    ["conversation", "core"],
    ["message", "core"],
  ]);
  const enums = new Map<string, string>();
  for (const { id, schema } of schemas) {
    for (const table of Object.values(schema.tables)) {
      claim(tables, getTableName(table), id, "table");
    }
    for (const pgEnum of Object.values(schema.enums)) {
      claim(enums, pgEnum.enumName, id, "enum");
    }
  }
}
