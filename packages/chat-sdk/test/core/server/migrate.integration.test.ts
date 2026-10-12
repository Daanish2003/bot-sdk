import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createChat } from "../../../core/server/create-chat";
import { LATEST_MIGRATION } from "../../../core/server/migrate";
import {
  dropScratchDatabase,
  freshDatabaseUrl,
  testDatabaseUrl,
} from "../../support/test-database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

function chatFor(databaseUrl: string) {
  return createChat({
    databaseUrl,
    getUser: () => null,
    keyEncryptionSecrets,
    basePath: "/api/chat",
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

afterAll(async () => {
  for (const url of scratch) await dropScratchDatabase(url);
}, 60_000);

const sdkTables = [
  "__migrations",
  "attachment",
  "attachment_blob",
  "conversation",
  "mcp_connection",
  "message",
  "message_attachment",
  "project",
  "shared_link",
  "usage",
  "user_credentials",
  "user_settings",
];

describe("chat.migrate()", () => {
  it("creates every table and enum in the chat schema on an empty database", async () => {
    const url = await scratchDatabase("empty");

    await chatFor(url).migrate();

    const tables = await rows<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema = 'chat'",
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([...sdkTables].sort());

    const enums = await rows<{ typname: string }>(
      url,
      `select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'chat' and t.typtype = 'e'`,
    );
    expect(enums.map((row) => row.typname).sort()).toEqual([
      "message_error_reason",
      "message_role",
      "message_status",
      "reasoning_effort",
      "usage_kind",
    ]);
  });

  it("adds the Run columns to chat.message as nullable timestamps", async () => {
    const url = await scratchDatabase("columns");

    await chatFor(url).migrate();

    const columns = await rows<{ column_name: string; data_type: string; is_nullable: string }>(
      url,
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'chat' and table_name = 'message'
         and column_name in ('cancel_requested_at', 'heartbeat_at')`,
    );
    expect(columns.sort((a, b) => a.column_name.localeCompare(b.column_name))).toEqual([
      {
        column_name: "cancel_requested_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
      { column_name: "heartbeat_at", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
  });

  it("adds the generation-control columns as nullable, additive columns", async () => {
    const url = await scratchDatabase("generation_columns");

    await chatFor(url).migrate();

    const columns = await rows<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      url,
      `select table_name, column_name, data_type, udt_name, is_nullable
         from information_schema.columns
        where table_schema = 'chat'
          and (table_name, column_name) in (
            ('user_settings', 'instructions'),
            ('conversation', 'reasoning_effort'),
            ('message', 'reasoning_effort'),
            ('message', 'usage'),
            ('message', 'context_start_id')
          )`,
    );
    expect(
      columns.sort((a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`),
      ),
    ).toEqual([
      {
        table_name: "conversation",
        column_name: "reasoning_effort",
        data_type: "USER-DEFINED",
        udt_name: "reasoning_effort",
        is_nullable: "YES",
      },
      {
        table_name: "message",
        column_name: "context_start_id",
        data_type: "uuid",
        udt_name: "uuid",
        is_nullable: "YES",
      },
      {
        table_name: "message",
        column_name: "reasoning_effort",
        data_type: "USER-DEFINED",
        udt_name: "reasoning_effort",
        is_nullable: "YES",
      },
      {
        table_name: "message",
        column_name: "usage",
        data_type: "jsonb",
        udt_name: "jsonb",
        is_nullable: "YES",
      },
      {
        table_name: "user_settings",
        column_name: "instructions",
        data_type: "text",
        udt_name: "text",
        is_nullable: "YES",
      },
    ]);
  });

  it("leaves rows written before the generation columns untouched, with nulls in them", async () => {
    const url = await scratchDatabase("existing_rows");
    const migrationsFolder = fileURLToPath(
      new URL("../../../core/server/migrations", import.meta.url),
    );
    const baselineName = "20261009085944_chat_baseline";
    const baseline = readFileSync(join(migrationsFolder, baselineName, "migration.sql"), "utf8");

    // Stand in for a database at the baseline: its SQL, and the journal row drizzle would write.
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("create schema chat");
      await client.query("create extension if not exists pg_trgm");
      await client.query(baseline);
      await client.query(`create table if not exists chat.__migrations (
        id serial primary key, hash text not null, created_at bigint)`);
      const baselineMillis = Date.UTC(2026, 9, 9, 8, 59, 44);
      await client.query("insert into chat.__migrations (hash, created_at) values ($1, $2)", [
        createHash("sha256").update(baseline).digest("hex"),
        baselineMillis,
      ]);
      await client.query(
        `insert into chat.conversation (id, user_id, title, model)
         values ('0196a000-0000-7000-8000-000000000001', 'user-1', 'Before', 'openai:gpt')`,
      );
      await client.query(
        `insert into chat.message (id, conversation_id, role, parts, status)
         values ('0196a000-0000-7000-8000-000000000002', '0196a000-0000-7000-8000-000000000001',
                 'user', '[]'::jsonb, 'complete')`,
      );
      await client.query(
        `insert into chat.user_settings (user_id, title_model) values ('user-1', 'openai:gpt')`,
      );
    } finally {
      await client.end();
    }

    await chatFor(url).migrate();

    expect(
      await rows(
        url,
        `select c.title, c.model, c.reasoning_effort, c.project_id, c.pinned_at, m.role, m.parts, m.reasoning_effort as m_effort,
                m.usage, m.context_start_id, s.title_model, s.instructions
           from chat.conversation c
           join chat.message m on m.conversation_id = c.id
           join chat.user_settings s on s.user_id = c.user_id`,
      ),
    ).toEqual([
      {
        title: "Before",
        model: "openai:gpt",
        reasoning_effort: null,
        project_id: null,
        pinned_at: null,
        role: "user",
        parts: [],
        m_effort: null,
        usage: null,
        context_start_id: null,
        title_model: "openai:gpt",
        instructions: null,
      },
    ]);
  });

  it("creates reasoning_effort as the enum off, low, medium, high", async () => {
    const url = await scratchDatabase("reasoning_enum");

    await chatFor(url).migrate();

    const values = await rows<{ enumlabel: string }>(
      url,
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'chat' and t.typname = 'reasoning_effort'
        order by e.enumsortorder`,
    );
    expect(values.map((row) => row.enumlabel)).toEqual(["off", "low", "medium", "high"]);
  });

  it("clears context_start_id, not the Message, when the Message it points to is deleted", async () => {
    const url = await scratchDatabase("context_start_fk");

    await chatFor(url).migrate();

    const constraints = await rows<{ confdeltype: string }>(
      url,
      `select c.confdeltype from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.conrelid = 'chat.message'::regclass
          and a.attname = 'context_start_id'`,
    );
    // 'n' is ON DELETE SET NULL.
    expect(constraints).toEqual([{ confdeltype: "n" }]);
  });

  it("cascades a Project's delete to its Conversations through the foreign key", async () => {
    const url = await scratchDatabase("project_fk");

    await chatFor(url).migrate();

    const constraints = await rows<{ confdeltype: string }>(
      url,
      `select c.confdeltype from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.conrelid = 'chat.conversation'::regclass
          and a.attname = 'project_id'`,
    );
    // 'c' is ON DELETE CASCADE.
    expect(constraints).toEqual([{ confdeltype: "c" }]);
  });

  it("names the trigram operator class with its schema, and no foreign key leaves chat", async () => {
    const url = await scratchDatabase("refs");

    await chatFor(url).migrate();

    // Postgres drops the schema from `pg_indexes` when it is on the search path, so the bundled
    // SQL is what shows the name.
    const migrationsFolder = fileURLToPath(
      new URL("../../../core/server/migrations", import.meta.url),
    );
    const migrationSql = readdirSync(migrationsFolder)
      .map((name) => readFileSync(join(migrationsFolder, name, "migration.sql"), "utf8"))
      .join("\n");
    expect(migrationSql.match(/gin_trgm_ops/g)).toHaveLength(2);
    expect(migrationSql.match(/public\.gin_trgm_ops/g)).toHaveLength(2);

    const outside = await rows<{ conname: string }>(
      url,
      `select c.conname from pg_constraint c
         join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
         join pg_class target on target.oid = c.confrelid
         join pg_namespace tn on tn.oid = target.relnamespace
       where c.contype = 'f' and n.nspname = 'chat' and tn.nspname <> 'chat'`,
    );
    expect(outside).toEqual([]);
  });

  it("does nothing when run again", async () => {
    const url = await scratchDatabase("rerun");
    const chat = chatFor(url);
    await chat.migrate();
    const before = await rows<{ count: string }>(url, "select count(*) from chat.__migrations");

    await chat.migrate();

    const after = await rows<{ count: string }>(url, "select count(*) from chat.__migrations");
    expect(after).toEqual(before);
  });

  it("lets two concurrent runs both succeed, with the migrations applied once", async () => {
    const url = await scratchDatabase("concurrent");
    const chat = chatFor(url);

    await expect(Promise.all([chat.migrate(), chat.migrate()])).resolves.toBeDefined();

    const applied = await rows<{ count: string }>(url, "select count(*) from chat.__migrations");
    expect(applied).toEqual([{ count: "7" }]);
  });

  it("gives a Conversation's tool settings empty lists by default, so existing rows read as empty", async () => {
    const url = await scratchDatabase("tool_settings");
    await chatFor(url).migrate();

    await rows(
      url,
      `insert into chat.conversation (id, user_id, model)
       values ('0196a000-0000-7000-8000-000000000001', 'user-1', 'anthropic:claude-sonnet-5-5')`,
    );
    const stored = await rows<{ tool_settings: unknown }>(
      url,
      `select tool_settings from chat.conversation where id = '0196a000-0000-7000-8000-000000000001'`,
    );

    expect(stored).toEqual([{ tool_settings: { connections: [], allowedTools: [] } }]);
  });

  it("throws an error naming pg_trgm when the role may not create it", async () => {
    const url = await scratchDatabase("no_trgm");
    // The schema exists already, so the failure is the extension and not the schema.
    await rows(url, "create schema chat");
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
    await rows(url, "delete from chat.__migrations");
    await expect(chat.start()).rejects.toThrow(/chat\.migrate\(\)/);
  });
});
