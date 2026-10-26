import { pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { type AnyFeature, defineFeature } from "../../../core/server/feature";
import type { Migration } from "../../../core/server/migrate";
import { mcp } from "../../../plugins/mcp/server";
import { migrationParts, migrationsOf, shippedMigrations } from "../../../scripts/migration-parts";
import {
  dropScratchDatabase,
  freshDatabaseUrl,
  testDatabaseUrl,
} from "../../support/test-database";
import { postgres } from "../../../core/server/database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

function chatFor(databaseUrl: string, features: readonly AnyFeature[] = []) {
  return createBotSdk({
    database: postgres({ connectionString: databaseUrl }),
    keyEncryptionSecrets,
    models: {},
    features,
  });
}

const createNote: Migration = {
  name: "0001_note",
  sql: `create table botsdk.test_note (
    id text primary key,
    bot_id uuid not null references botsdk.bot(id) on delete cascade
  )`,
};
const addNoteText: Migration = {
  name: "0002_note_text",
  sql: "alter table botsdk.test_note add column text text",
};

/**
 * A test feature with one table, whose foreign key into the core's `bot` cascades; `migrations`
 * are the ones its release ships.
 */
function notes(migrations: readonly Migration[] = [createNote]) {
  const note = pgSchema("botsdk").table("test_note", {
    id: text("id").primaryKey(),
    botId: uuid("bot_id").notNull(),
  });
  return defineFeature({ id: "notes", schema: { tables: { note }, migrations } });
}

/** The journal's rows, as each part's migration names, in the order they were applied. */
function journal(url: string) {
  return rows<{ feature: string; migration: string }>(
    url,
    "select feature, migration from botsdk.__migrations order by applied_at, feature, migration",
  );
}

/** The `botsdk` schema's tables, sorted. */
async function tablesOf(url: string) {
  const tables = await rows<{ table_name: string }>(
    url,
    "select table_name from information_schema.tables where table_schema = 'botsdk'",
  );
  return tables.map((row) => row.table_name).sort();
}

/** A Bot (and its Conversation) for a user, by raw SQL: its id. */
async function insertBot(url: string) {
  const [created] = await rows<{ id: string }>(
    url,
    `with c as (
       insert into botsdk.conversation (id, user_id, kind) values (gen_random_uuid(), 'u1', 'bot')
       returning id)
     insert into botsdk.bot (id, user_id, conversation_id, name, model)
     select gen_random_uuid(), 'u1', c.id, 'Ada', 'openai:gpt-5' from c returning id`,
  );
  return created!.id;
}

/** Rows of a query run on its own connection, so each call sees the database as it is now. */
async function rows<T extends object>(url: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const scratch: string[] = [];

async function scratchDatabase(suffix: string) {
  const url = await freshDatabaseUrl(suffix);
  scratch.push(url);
  return url;
}

// Each DROP DATABASE forces a checkpoint, which is slow when other suites write at the same time.
// Dropping after every test spreads them out; dropping all of them in one afterAll timed out under load.
afterEach(async () => {
  for (const url of scratch.splice(0)) await dropScratchDatabase(url);
}, 120_000);

/** The core's tables: every Host has them, whatever features it enables. */
const coreTables = [
  "__migrations",
  "blob",
  "bot",
  "bot_check_in",
  "bot_demonstration",
  "bot_demonstration_event",
  "bot_helper",
  "bot_helper_message",
  "bot_helper_screenshot",
  "bot_prompt_start",
  "bot_review",
  "bot_routine",
  "bot_summary",
  "bot_trigger",
  "bot_turn",
  "bot_upload",
  "channel_email_address",
  "computer",
  "conversation",
  "conversation_change",
  "job",
  "job_event",
  "message",
  "model_settings",
  "secret",
  "usage",
  "user_credentials",
];

describe("chat.migrate()", () => {
  it("creates only the core's tables and enums in the `botsdk` schema with no features", async () => {
    const url = await scratchDatabase("empty");

    await chatFor(url).migrate();

    expect(await tablesOf(url)).toEqual([...coreTables].sort());

    const enums = await rows<{ typname: string }>(
      url,
      `select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'botsdk' and t.typtype = 'e'`,
    );
    expect(enums.map((row) => row.typname).sort()).toEqual([
      "bot_check_in_state",
      "bot_demonstration_event_kind",
      "bot_demonstration_state",
      "bot_helper_status",
      "bot_helper_type",
      "bot_review_state",
      "bot_review_verdict",
      "bot_routine_state",
      "bot_summary_kind",
      "bot_trigger_channel",
      "bot_trigger_source",
      "bot_turn_status",
      "computer_state",
      "job_status",
      "message_error_reason",
      "message_role",
      "message_status",
      "usage_kind",
    ]);

    // One baseline, journaled in the SDK's own schema under the core.
    expect(await journal(url)).toEqual([
      { feature: "core", migration: "20261026182921_botsdk_baseline" },
    ]);
    // Images and PDFs are already compressed, so the bytes are kept out of line uncompressed.
    expect(
      await rows(
        url,
        `select attstorage from pg_attribute
         where attrelid = 'botsdk.blob'::regclass and attname = 'bytes'`,
      ),
    ).toEqual([{ attstorage: "e" }]);
  });

  it("leaves a new database without the vector extension", async () => {
    const url = await scratchDatabase("k743_no_vector");

    await chatFor(url).migrate();

    expect(await rows(url, "select 1 from pg_extension where extname = 'vector'")).toEqual([]);
  });

  it("keeps every foreign key inside the `botsdk` schema", async () => {
    const url = await scratchDatabase("refs");

    await chatFor(url).migrate();

    const outside = await rows<{ conname: string }>(
      url,
      `select c.conname from pg_constraint c
         join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
         join pg_class target on target.oid = c.confrelid
         join pg_namespace tn on tn.oid = target.relnamespace
       where c.contype = 'f' and n.nspname = 'botsdk' and tn.nspname <> 'botsdk'`,
    );
    expect(outside).toEqual([]);
  });

  it("adds an enabled feature's tables, and only its, after the core's", async () => {
    const url = await scratchDatabase("feature");

    await chatFor(url, [notes(), mcp()]).migrate();

    expect(await tablesOf(url)).toEqual([...coreTables, "mcp_connection", "test_note"].sort());
    expect(await journal(url)).toEqual([
      { feature: "core", migration: "20261026182921_botsdk_baseline" },
      { feature: "notes", migration: "0001_note" },
      { feature: "mcp", migration: "20261026182927_mcp_baseline" },
    ]);
  });

  it("applies only a feature's migrations when it is enabled later, and only its new ones", async () => {
    const url = await scratchDatabase("later");
    await chatFor(url).migrate();
    const core = await rows(url, "select * from botsdk.__migrations");

    await chatFor(url, [notes()]).migrate();
    await chatFor(url, [notes([createNote, addNoteText])]).migrate();

    expect(await rows(url, "select * from botsdk.__migrations where feature = 'core'")).toEqual(
      core,
    );
    expect(await journal(url)).toEqual([
      { feature: "core", migration: "20261026182921_botsdk_baseline" },
      { feature: "notes", migration: "0001_note" },
      { feature: "notes", migration: "0002_note_text" },
    ]);
    const columns = await rows<{ column_name: string }>(
      url,
      `select column_name from information_schema.columns
       where table_schema = 'botsdk' and table_name = 'test_note' order by column_name`,
    );
    expect(columns.map((row) => row.column_name)).toEqual(["bot_id", "id", "text"]);
  });

  it("leaves a disabled feature's tables and rows in place", async () => {
    const url = await scratchDatabase("disabled");
    await chatFor(url, [notes()]).migrate();
    const botId = await insertBot(url);
    await rows(url, `insert into botsdk.test_note (id, bot_id) values ('n1', '${botId}')`);

    const without = chatFor(url);
    await without.migrate();
    await without.start();
    await without.stop();

    expect(await rows(url, "select id from botsdk.test_note")).toEqual([{ id: "n1" }]);
    expect(await journal(url)).toContainEqual({ feature: "notes", migration: "0001_note" });
  });

  it("lets a feature's table cascade on a delete of the core row it references", async () => {
    const url = await scratchDatabase("cascade");
    await chatFor(url, [notes()]).migrate();
    const botId = await insertBot(url);
    await rows(url, `insert into botsdk.test_note (id, bot_id) values ('n1', '${botId}')`);

    await rows(url, `delete from botsdk.bot where id = '${botId}'`);

    expect(await rows(url, "select id from botsdk.test_note")).toEqual([]);
  });

  it("refuses a feature that names two migrations alike, applying neither", async () => {
    const url = await scratchDatabase("dup_name");

    await expect(
      chatFor(url, [notes([createNote, { ...addNoteText, name: createNote.name }])]).migrate(),
    ).rejects.toThrow(/Feature "notes" has two migrations named "0001_note"/);
    expect(await tablesOf(url)).not.toContain("test_note");
  });

  it("does nothing when run again", async () => {
    const url = await scratchDatabase("rerun");
    const chat = chatFor(url);
    await chat.migrate();
    const before = await rows<{ count: string }>(url, "select count(*) from botsdk.__migrations");

    await chat.migrate();

    const after = await rows<{ count: string }>(url, "select count(*) from botsdk.__migrations");
    expect(after).toEqual(before);
  });

  it(
    "makes a second run wait on the lock while the first applies",
    { timeout: 60_000 },
    async () => {
      const url = await scratchDatabase("serialized");
      // A feature whose migration waits until the test lets it go, so the first run holds the
      // migration lock for as long as the test wants.
      const gateId = 7_270_042;
      const gated = defineFeature({
        id: "gated",
        schema: {
          migrations: [
            {
              name: "0001_gate",
              sql: `select pg_advisory_xact_lock(${gateId}); create table botsdk.test_gate (id int)`,
            },
          ],
        },
      });
      const gate = new Client({ connectionString: url });
      await gate.connect();
      try {
        await gate.query("select pg_advisory_lock($1)", [gateId]);
        const chat = chatFor(url, [gated]);
        const first = chat.migrate();
        // The first run is inside the gated migration before the second starts.
        const waitingOn = async (query: string) =>
          (
            await gate.query<{ count: string }>(
              `select count(*) from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and query like $1`,
              [query],
            )
          ).rows[0]?.count;
        await expect
          .poll(() => waitingOn("%pg_advisory_xact_lock%"), { timeout: 10_000 })
          .toBe("1");
        const second = chat.migrate();

        // The second waits for the migration lock, not inside the migration.
        await expect
          .poll(() => waitingOn("select pg_advisory_lock($1)"), { timeout: 10_000 })
          .toBe("1");
        expect(await waitingOn("%pg_advisory_xact_lock%")).toBe("1");

        await gate.query("select pg_advisory_unlock($1)", [gateId]);
        await Promise.all([first, second]);
      } finally {
        await gate.end();
      }
      expect((await journal(url)).filter(({ feature }) => feature === "gated")).toEqual([
        { feature: "gated", migration: "0001_gate" },
      ]);
    },
  );

  it("lets two concurrent runs both succeed, with the migrations applied once", async () => {
    const url = await scratchDatabase("concurrent");
    const chat = chatFor(url, [notes()]);

    await expect(Promise.all([chat.migrate(), chat.migrate()])).resolves.toBeDefined();

    expect(await journal(url)).toEqual([
      { feature: "core", migration: "20261026182921_botsdk_baseline" },
      { feature: "notes", migration: "0001_note" },
    ]);
  });

  it("throws an error naming pg_trgm when the role may not create it", async () => {
    const url = await scratchDatabase("no_trgm");
    // The schema exists already, so the failure is the extension and not the schema.
    await rows(url, "create schema botsdk");
    await rows(
      testDatabaseUrl,
      `do $$ begin
         create role chat_no_create login password 'password';
       exception when duplicate_object then null; end $$`,
    );
    const roleUrl = new URL(url);
    roleUrl.username = "chat_no_create";
    roleUrl.password = "password";

    await expect(chatFor(roleUrl.toString()).migrate()).rejects.toThrow(/pg_trgm/);
  });

  it(
    "leaves the lock free after a run that fails over the Host's pool",
    { timeout: 30_000 },
    async () => {
      const url = await scratchDatabase("pool_fail");
      await rows(url, "create schema botsdk");
      await rows(
        testDatabaseUrl,
        `do $$ begin
           create role chat_no_create login password 'password';
         exception when duplicate_object then null; end $$`,
      );
      const roleUrl = new URL(url);
      roleUrl.username = "chat_no_create";
      roleUrl.password = "password";
      // No idle timeout, so a connection returned with the lock would keep it.
      const pool = new Pool({ connectionString: roleUrl.toString(), idleTimeoutMillis: 0 });
      try {
        const failing = createBotSdk({
          database: postgres({ pool }),
          keyEncryptionSecrets,
          models: {},
        });
        await expect(failing.migrate()).rejects.toThrow(/pg_trgm/);

        // The Host's pool is still open; a run on another connection gets the lock.
        await chatFor(url).migrate();
        const applied = await rows<{ count: string }>(
          url,
          "select count(*) from botsdk.__migrations",
        );
        expect(applied).toEqual([{ count: "1" }]);
      } finally {
        await pool.end();
      }
    },
  );
});

describe("chat.start()", () => {
  it("checks against each part's migrations.json, which match its drizzle-kit folders", () => {
    for (const { folder } of migrationParts) {
      expect(shippedMigrations(folder), `run \`pnpm db:generate\` for ${folder}`).toEqual(
        migrationsOf(folder),
      );
    }
  });

  it("throws, naming the feature, while an enabled feature's migrations aren't all applied", async () => {
    const url = await scratchDatabase("start_feature");
    await chatFor(url).migrate();

    await expect(chatFor(url, [notes()]).start()).rejects.toThrow(
      /Feature "notes".*chat\.migrate\(\)/,
    );

    await chatFor(url, [notes()]).migrate();
    await expect(chatFor(url, [notes([createNote, addNoteText])]).start()).rejects.toThrow(
      /Feature "notes".*chat\.migrate\(\)/,
    );
  });

  it("throws on a database that was never migrated", async () => {
    const url = await scratchDatabase("start_empty");

    await expect(chatFor(url).start()).rejects.toThrow(/chat\.migrate\(\)/);
  });

  it("starts once migrated, and throws again when the journal is behind", async () => {
    const url = await scratchDatabase("start_stale");
    const chat = chatFor(url);
    await chat.migrate();

    await expect(chat.start()).resolves.toBeUndefined();
    // start() set the reaper going; stop it so it doesn't outlive the test.
    await chat.stop();

    // A journal with nothing applied is behind the bundled migrations.
    await rows(url, "delete from botsdk.__migrations");
    await expect(chat.start()).rejects.toThrow(/chat\.migrate\(\)/);
  });
});
