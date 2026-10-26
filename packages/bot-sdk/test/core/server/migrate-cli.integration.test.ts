import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { postgres } from "../../../core/server/database";
import { defineFeature } from "../../../core/server/feature";
import { migrate } from "../../../core/server/migrate";
import { runMigrate } from "../../../core/server/migrate-cli";
import { dropScratchDatabase, freshDatabaseUrl } from "../../support/test-database";

const bin = fileURLToPath(new URL("../../../bin/botsdk.mjs", import.meta.url));
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
    { database: postgres({ connectionString: url }), features },
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
        { database: postgres({ connectionString: url }), features: [notes] },
        {},
        () => {},
      );
      return url;
    }

    it("removes a disabled feature's tables and journal rows only when asked", async () => {
      const url = await migratedWithNotes("cli_drop");
      const database = postgres({ connectionString: url });
      // Left out of the features, the tables stay.
      await runMigrate({ database, features: [], disabled: [notes] }, {}, () => {});
      expect(await tablesOf(url)).toContain("test_note");
      // --print shows the SQL and changes nothing.
      let out = "";
      await runMigrate(
        { database, features: [], disabled: [notes] },
        { drop: "notes", print: true },
        (t) => (out += t),
      );
      expect(out).toContain('drop table if exists "botsdk"."test_note"');
      expect(await tablesOf(url)).toContain("test_note");
      await runMigrate({ database, features: [], disabled: [notes] }, { drop: "notes" }, () => {});
      expect(await tablesOf(url)).not.toContain("test_note");
      expect((await journalOf(url)).map((row) => row.feature)).not.toContain("notes");
      // Enabled again, it migrates from its baseline.
      await runMigrate({ database, features: [notes] }, {}, () => {});
      expect(await tablesOf(url)).toContain("test_note");
    }, 60_000);

    it("refuses a feature that is enabled", async () => {
      const url = await migratedWithNotes("cli_drop_enabled");
      await expect(
        runMigrate(
          { database: postgres({ connectionString: url }), features: [notes] },
          { drop: "notes" },
          () => {},
        ),
      ).rejects.toThrow(/is enabled/);
      expect(await tablesOf(url)).toContain("test_note");
    }, 60_000);
  });
});
