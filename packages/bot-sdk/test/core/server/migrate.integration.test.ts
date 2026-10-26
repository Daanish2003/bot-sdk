import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { LATEST_MIGRATION } from "../../../core/server/migrate";
import {
  dropScratchDatabase,
  freshDatabaseUrl,
  testDatabaseUrl,
} from "../../support/test-database";
import { postgres } from "../../../core/server/database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

function chatFor(databaseUrl: string) {
  return createBotSdk({
    database: postgres({ connectionString: databaseUrl }),
    keyEncryptionSecrets,
    models: {},
  });
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

const sdkTables = [
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
  "mcp_connection",
  "memory_settings",
  "message",
  "model_settings",
  "secret",
  "usage",
  "user_credentials",
];

describe("chat.migrate()", () => {
  it("creates every table and enum in the `botsdk` schema on an empty database", async () => {
    const url = await scratchDatabase("empty");

    await chatFor(url).migrate();

    const tables = await rows<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema = 'botsdk'",
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([...sdkTables].sort());

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

    // One baseline, journaled in the SDK's own schema.
    expect(await rows(url, "select count(*)::int as count from botsdk.__migrations")).toEqual([
      { count: 1 },
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

  it("does nothing when run again", async () => {
    const url = await scratchDatabase("rerun");
    const chat = chatFor(url);
    await chat.migrate();
    const before = await rows<{ count: string }>(url, "select count(*) from botsdk.__migrations");

    await chat.migrate();

    const after = await rows<{ count: string }>(url, "select count(*) from botsdk.__migrations");
    expect(after).toEqual(before);
  });

  it("lets two concurrent runs both succeed, with the migrations applied once", async () => {
    const url = await scratchDatabase("concurrent");
    const chat = chatFor(url);

    await expect(Promise.all([chat.migrate(), chat.migrate()])).resolves.toBeDefined();

    const applied = await rows<{ count: string }>(url, "select count(*) from botsdk.__migrations");
    expect(applied).toEqual([{ count: "1" }]);
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
  it("checks against the newest migration folder, which the bundle can't read", () => {
    const migrationsFolder = fileURLToPath(
      new URL("../../../core/server/migrations", import.meta.url),
    );
    const newest = readdirSync(migrationsFolder).sort().at(-1);

    expect(LATEST_MIGRATION).toBe(newest);
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
