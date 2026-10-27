import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { integer, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { postgres } from "../src/database";
import { defineFeature } from "../src/feature";
import { migrate } from "../src/migrate";
import { runMigrate } from "../src/migrate-cli";
import { dropScratchDatabase, freshDatabaseUrl } from "@ai-chat/test-support/test-database";

const botRoot = dirname(createRequire(import.meta.url).resolve("@botsdk/bot/package.json"));
const bin = join(botRoot, "bin/botsdk.mjs");
const config = fileURLToPath(new URL("./fixtures/botsdk.config.ts", import.meta.url));

const notes = defineFeature({
  id: "notes",
  schema: {
    tables: {
      note: pgSchema("botsdk").table("test_note", {
        id: text("id").primaryKey(),
        botId: uuid("bot_id"),
      }),
    },
    migrations: [
      {
        name: "0001_note",
        sql: "create table botsdk.test_note (id text primary key, bot_id uuid references botsdk.bot(id) on delete cascade)",
      },
    ],
  },
});

// A feature with its own enums (one no column uses) and a sequence no table owns: --drop removes
// what it declares, so enabling it again creates them anew.
const botsdk = pgSchema("botsdk");
const tagKind = botsdk.enum("test_tag_kind", ["red", "blue"]);
const tags = defineFeature({
  id: "tags",
  schema: {
    enums: { tagKind, tagShade: botsdk.enum("test_tag_shade", ["light", "dark"]) },
    sequences: { tagPosition: botsdk.sequence("test_tag_position") },
    tables: {
      tag: botsdk.table("test_tag", {
        id: text("id").primaryKey(),
        kind: tagKind("kind").notNull(),
        position: integer("position"),
      }),
    },
    migrations: [
      {
        name: "0001_tag",
        sql: [
          "create type botsdk.test_tag_kind as enum ('red', 'blue');",
          "create type botsdk.test_tag_shade as enum ('light', 'dark');",
          "create sequence botsdk.test_tag_position;",
          "create table botsdk.test_tag (id text primary key, kind botsdk.test_tag_kind not null, position integer default nextval('botsdk.test_tag_position'));",
        ].join(" "),
      },
    ],
  },
});

const scratch: string[] = [];
async function scratchDatabase(suffix: string) {
  const url = await freshDatabaseUrl(suffix);
  scratch.push(url);
  return url;
}
afterEach(async () => {
  for (const url of scratch.splice(0)) await dropScratchDatabase(url);
}, 120_000);

async function rows<T extends object>(url: string, query: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(query)).rows;
  } finally {
    await client.end();
  }
}

const tablesOf = async (url: string) =>
  (
    await rows<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema = 'botsdk' order by 1",
    )
  ).map((row) => row.table_name);

const journalOf = (url: string) =>
  rows<{ feature: string; migration: string }>(
    url,
    "select feature, migration from botsdk.__migrations order by feature, migration",
  );

async function printed(url: string, features = [notes]) {
  let sql = "";
  await runMigrate(
    { default: { database: postgres({ connectionString: url }), features } },
    { print: true },
    (text) => {
      sql += text;
    },
  );
  return sql;
}

describe("botsdk migrate", () => {
  it("migrates a fresh database for the Host's config", async () => {
    const url = await scratchDatabase("cli_migrate");
    await promisify(execFile)(process.execPath, [bin, "migrate", "--config", config], {
      env: { ...process.env, BOTSDK_TEST_DATABASE_URL: url },
    });
    expect(await tablesOf(url)).toContain("mcp_connection");
    expect((await journalOf(url)).map((row) => row.feature)).toContain("mcp");
  }, 60_000);

  it("--print gives the pending SQL, and nothing is applied", async () => {
    const url = await scratchDatabase("cli_print");
    const sql = await printed(url);
    expect(sql).toMatchSnapshot();
    expect(await tablesOf(url)).toEqual([]);
  }, 60_000);

  it("--print gives SQL that, applied, leaves what migrate leaves", async () => {
    const printUrl = await scratchDatabase("cli_print_src");
    const sql = await printed(printUrl);
    const appliedUrl = await scratchDatabase("cli_print_applied");
    await rows(appliedUrl, sql);
    const migratedUrl = await scratchDatabase("cli_print_migrated");
    await migrate(postgres({ connectionString: migratedUrl }), [
      { feature: "notes", migrations: notes.schema!.migrations! },
    ]);
    expect(await tablesOf(appliedUrl)).toEqual(await tablesOf(migratedUrl));
    expect(await journalOf(appliedUrl)).toEqual(await journalOf(migratedUrl));
    // Nothing is pending after it.
    expect(await printed(appliedUrl)).not.toContain("-- ");
  }, 60_000);

  describe("--drop", () => {
    async function migratedWithNotes(suffix: string) {
      const url = await scratchDatabase(suffix);
      await runMigrate(
        { default: { database: postgres({ connectionString: url }), features: [notes] } },
        {},
        () => {},
      );
      return url;
    }

    it("removes a disabled feature's tables and journal rows only when asked", async () => {
      const url = await migratedWithNotes("cli_drop");
      const database = postgres({ connectionString: url });
      // Left out of the features, the tables stay.
      await runMigrate({ default: { database, features: [] }, disabled: [notes] }, {}, () => {});
      expect(await tablesOf(url)).toContain("test_note");
      // --print shows the SQL and changes nothing.
      let out = "";
      await runMigrate(
        { default: { database, features: [] }, disabled: [notes] },
        { drop: "notes", print: true },
        (t) => (out += t),
      );
      expect(out).toContain(`'"botsdk"."test_note"'`);
      expect(await tablesOf(url)).toContain("test_note");
      await runMigrate(
        { default: { database, features: [] }, disabled: [notes] },
        { drop: "notes" },
        () => {},
      );
      expect(await tablesOf(url)).not.toContain("test_note");
      expect((await journalOf(url)).map((row) => row.feature)).not.toContain("notes");
      // Enabled again, it migrates from its baseline.
      await runMigrate({ default: { database, features: [notes] } }, {}, () => {});
      expect(await tablesOf(url)).toContain("test_note");
    }, 60_000);

    it("removes the feature's own enums and unowned sequences, so enabling it again migrates", async () => {
      const url = await scratchDatabase("cli_drop_types");
      const database = postgres({ connectionString: url });
      await runMigrate({ default: { database, features: [tags] } }, {}, () => {});
      const typesOf = async () =>
        (
          await rows<{ name: string }>(
            url,
            "select typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'botsdk' and t.typname like 'test_tag%' union select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'botsdk' and c.relkind = 'S' and c.relname like 'test_tag%' order by 1",
          )
        ).map((row) => row.name);
      expect(await typesOf()).toEqual(
        expect.arrayContaining(["test_tag_kind", "test_tag_position", "test_tag_shade"]),
      );

      await runMigrate(
        { default: { database, features: [] }, disabled: [tags] },
        { drop: "tags" },
        () => {},
      );
      expect(await typesOf()).toEqual([]);
      // The core's enums are still there.
      expect(await tablesOf(url)).toContain("bot_check_in");

      await runMigrate({ default: { database, features: [tags] } }, {}, () => {});
      expect(await tablesOf(url)).toContain("test_tag");
    }, 60_000);

    it("keeps a declared enum another feature's table still uses", async () => {
      const color = botsdk.enum("test_color", ["red", "blue"]);
      const palette = defineFeature({
        id: "palette",
        schema: {
          enums: { color },
          migrations: [
            { name: "0001_color", sql: "create type botsdk.test_color as enum ('red', 'blue')" },
          ],
        },
      });
      const paints = defineFeature({
        id: "paints",
        schema: {
          tables: { paint: botsdk.table("test_paint", { color: color("color") }) },
          migrations: [
            { name: "0001_paint", sql: "create table botsdk.test_paint (color botsdk.test_color)" },
          ],
        },
      });
      const url = await scratchDatabase("cli_drop_shared");
      const database = postgres({ connectionString: url });
      await runMigrate({ default: { database, features: [palette, paints] } }, {}, () => {});

      await runMigrate(
        { default: { database, features: [paints] }, disabled: [palette] },
        { drop: "palette" },
        () => {},
      );
      expect(await rows(url, "select 1 from pg_type where typname = 'test_color'")).toHaveLength(1);
      expect((await journalOf(url)).map((row) => row.feature)).not.toContain("palette");
    }, 60_000);

    it("takes the feature to drop from the config module's `disabled` export", async () => {
      const url = await scratchDatabase("cli_drop_bin");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [bin, "migrate", "--config", config, "--drop", "memory", "--print"],
        { env: { ...process.env, BOTSDK_TEST_DATABASE_URL: url } },
      );
      expect(stdout).toContain('"botsdk"."memory_settings"');
    }, 60_000);

    it("keeps a core enum the feature declares and uses, and drops a table a cascade already took", async () => {
      // A child table that inherits from the first: the cascade on the parent drops it first.
      const checkInState = botsdk.enum("bot_check_in_state", ["pending"]);
      const borrowed = defineFeature({
        id: "borrowed",
        schema: {
          enums: { checkInState },
          tables: {
            parent: botsdk.table("test_parent", {
              state: checkInState("state"),
            }),
            child: botsdk.table("test_child", {}),
          },
          migrations: [
            {
              name: "0001_parent",
              sql: "create table botsdk.test_parent (state botsdk.bot_check_in_state); create table botsdk.test_child () inherits (botsdk.test_parent);",
            },
          ],
        },
      });
      const url = await scratchDatabase("cli_drop_borrowed");
      const database = postgres({ connectionString: url });
      // Its only user: the core's own table is emptied of the type for the test.
      await runMigrate({ default: { database, features: [borrowed] } }, {}, () => {});
      await rows(url, "alter table botsdk.bot_check_in alter column state type text");

      await runMigrate(
        { default: { database, features: [] }, disabled: [borrowed] },
        { drop: "borrowed" },
        () => {},
      );
      expect(await tablesOf(url)).not.toContain("test_parent");
      expect(await tablesOf(url)).not.toContain("test_child");
      expect(
        await rows(url, "select 1 from pg_type where typname = 'bot_check_in_state'"),
      ).toHaveLength(1);
    }, 60_000);

    it("says what the config module must export when it has no default", async () => {
      await expect(runMigrate({} as never, { drop: "notes" }, () => {})).rejects.toThrow(
        /default-export the options you pass createBotSdk/,
      );
    });

    it("refuses a feature that is enabled", async () => {
      const url = await migratedWithNotes("cli_drop_enabled");
      await expect(
        runMigrate(
          { default: { database: postgres({ connectionString: url }), features: [notes] } },
          { drop: "notes" },
          () => {},
        ),
      ).rejects.toThrow(/is enabled/);
      expect(await tablesOf(url)).toContain("test_note");
    }, 60_000);
  });
});
