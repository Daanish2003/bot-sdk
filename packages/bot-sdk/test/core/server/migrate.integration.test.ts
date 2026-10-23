import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { runner } from "../../../plugins/runner/server/plugin";
import { models } from "../../../plugins/models/server/plugin";
import { LATEST_MIGRATION } from "../../../core/server/migrate";
import {
  dropScratchDatabase,
  freshDatabaseUrl,
  testDatabaseUrl,
} from "../../support/test-database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

function chatFor(databaseUrl: string) {
  return createBotSdk({
    databaseUrl,
    getUser: () => null,
    keyEncryptionSecrets,
    basePath: "/api/chat",
    plugins: [models(), runner(), assistant()],
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

/** Applies the bundled migrations up to and including `last`, as `chat.migrate()` would have then. */
async function migrateUpTo(url: string, last: string) {
  const bundled = fileURLToPath(new URL("../../../core/server/migrations", import.meta.url));
  const folder = mkdtempSync(join(tmpdir(), "chat-migrations-"));
  try {
    for (const name of readdirSync(bundled).filter((name) => name <= last)) {
      cpSync(join(bundled, name), join(folder, name), { recursive: true });
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("create schema chat");
      await client.query("create extension if not exists pg_trgm");
      await client.query("create extension if not exists vector");
      await applyMigrations(drizzle({ client }), {
        migrationsFolder: folder,
        migrationsSchema: "chat",
        migrationsTable: "__migrations",
      });
    } finally {
      await client.end();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
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
  "artifact",
  "artifact_version",
  "attachment",
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
  "generated_image",
  "job",
  "job_event",
  "mcp_connection",
  "memory_settings",
  "message",
  "message_attachment",
  "project",
  "saved_prompt",
  "secret",
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
      "artifact_kind",
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
      "message_rating",
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
        `select c.kind, c.title, c.model, c.reasoning_effort, c.project_id, c.pinned_at, m.role, m.parts, m.reasoning_effort as m_effort,
                m.usage, m.context_start_id, s.background_model, s.instructions
           from chat.conversation c
           join chat.message m on m.conversation_id = c.id
           join chat.user_settings s on s.user_id = c.user_id`,
      ),
    ).toEqual([
      {
        kind: "assistant",
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
        background_model: "openai:gpt",
        instructions: null,
      },
    ]);
  });

  it("copies existing attachment bytes into chat.blob under attachment/<id>, then drops the old table", async () => {
    const url = await scratchDatabase("blob_copy");
    const migrationsFolder = fileURLToPath(
      new URL("../../../core/server/migrations", import.meta.url),
    );
    const baseline = readFileSync(
      join(migrationsFolder, "20261009085944_chat_baseline", "migration.sql"),
      "utf8",
    );
    const attachmentId = "0196a000-0000-7000-8000-0000000000aa";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    // A database at the baseline with one Attachment whose bytes sit in attachment_blob.
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("create schema chat");
      await client.query("create extension if not exists pg_trgm");
      await client.query(baseline);
      await client.query(`create table if not exists chat.__migrations (
        id serial primary key, hash text not null, created_at bigint)`);
      await client.query("insert into chat.__migrations (hash, created_at) values ($1, $2)", [
        createHash("sha256").update(baseline).digest("hex"),
        Date.UTC(2026, 9, 9, 8, 59, 44),
      ]);
      await client.query(
        `insert into chat.attachment (id, user_id, filename, media_type, size)
         values ($1, 'user-1', 'a.png', 'image/png', $2)`,
        [attachmentId, bytes.byteLength],
      );
      await client.query(
        "insert into chat.attachment_blob (attachment_id, bytes) values ($1, $2)",
        [attachmentId, bytes],
      );
    } finally {
      await client.end();
    }

    await chatFor(url).migrate();

    const stored = await rows<{ key: string; bytes: Buffer }>(
      url,
      "select key, bytes from chat.blob",
    );
    expect(stored.map((row) => row.key)).toEqual([`attachment/${attachmentId}`]);
    expect(Buffer.from(stored[0]?.bytes ?? []).equals(bytes)).toBe(true);
    const oldTable = await rows(
      url,
      "select 1 from information_schema.tables where table_schema = 'chat' and table_name = 'attachment_blob'",
    );
    expect(oldTable).toEqual([]);
  });

  it("copies each memory_enabled that is off into chat.memory_settings, then drops the old column", async () => {
    const url = await scratchDatabase("memory_settings");
    // A database at the migration before the Memory plugin's, with two users' settings.
    await migrateUpTo(url, "20261020044023_bot_helper_screenshot");
    await rows(
      url,
      `insert into chat.user_settings (user_id, memory_enabled, instructions)
       values ('user-off', false, 'Be brief'), ('user-on', true, null)`,
    );

    await chatFor(url).migrate();

    const settings = await rows<{ user_id: string; enabled: boolean }>(
      url,
      "select user_id, enabled from chat.memory_settings order by user_id",
    );
    // Only a switch turned off is copied: a user with no row has Memory on, so nothing is left
    // behind for a Host without the memory plugin to keep after a user delete.
    expect(settings).toEqual([{ user_id: "user-off", enabled: false }]);
    const oldColumn = await rows(
      url,
      `select 1 from information_schema.columns
       where table_schema = 'chat' and table_name = 'user_settings' and column_name = 'memory_enabled'`,
    );
    expect(oldColumn).toEqual([]);
    // The rest of the user's settings stay.
    expect(
      await rows(url, "select user_id, instructions from chat.user_settings order by user_id"),
    ).toEqual([
      { user_id: "user-off", instructions: "Be brief" },
      { user_id: "user-on", instructions: null },
    ]);
  });

  it("drops the assistant's Memories and their queued jobs, and keeps the Memory switch (#650)", async () => {
    const url = await scratchDatabase("drop_memory");
    // A database at the migration before the drop, with a Memory switch and the Memory jobs.
    await migrateUpTo(url, "20261020095556_bot_turn_memory_changes");
    await rows(
      url,
      "insert into chat.memory_settings (user_id, enabled) values ('user-off', false)",
    );
    await rows(
      url,
      `insert into chat.job (id, name, payload) values
         (gen_random_uuid(), 'memory.make', '{}'),
         (gen_random_uuid(), 'memory.reembed', '{}'),
         (gen_random_uuid(), 'memory.bot-pass', '{}')`,
    );

    await chatFor(url).migrate();

    const table = await rows(
      url,
      "select 1 from information_schema.tables where table_schema = 'chat' and table_name = 'memory'",
    );
    expect(table).toEqual([]);
    const origin = await rows(
      url,
      `select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'chat' and t.typname = 'memory_origin'`,
    );
    expect(origin).toEqual([]);
    expect(await rows(url, "select name from chat.job order by name")).toEqual([
      { name: "memory.bot-pass" },
    ]);
    expect(await rows(url, "select user_id, enabled from chat.memory_settings")).toEqual([
      { user_id: "user-off", enabled: false },
    ]);
  });

  it("leaves a new database without the vector extension", async () => {
    const url = await scratchDatabase("k743_no_vector");

    await chatFor(url).migrate();

    expect(await rows(url, "select 1 from pg_extension where extname = 'vector'")).toEqual([]);
  });

  it("drops the old Knowledge: its tables, enum, bytes, jobs, search parts and the vector extension (#743)", async () => {
    const url = await scratchDatabase("k743_drop");
    // A database at the migration before the drop, its passages in a pgvector column as they were
    // written, with one Project's Knowledge file, its bytes, its job and a reply that searched it.
    await migrateUpTo(url, "20261022061821_bot_turn_knowledge_changes");
    await rows(
      url,
      `alter table chat.knowledge_chunk alter column embedding type vector(1536) using embedding::vector(1536)`,
    );
    const fileId = "0196a000-0000-7000-8000-0000000000f1";
    await rows(
      url,
      `insert into chat.project (id, user_id, name, embedding_model)
         values ('0196a000-0000-7000-8000-0000000000a1', 'user-1', 'Launch', 'openai:text-embedding-3-small')`,
    );
    await rows(
      url,
      `insert into chat.knowledge_file (id, user_id, project_id, name, media_type, size, status)
         values ('${fileId}', 'user-1', '0196a000-0000-7000-8000-0000000000a1', 'brief.md', 'text/markdown', 3, 'ready')`,
    );
    await rows(
      url,
      `insert into chat.blob (key, bytes) values
         ('knowledge/${fileId}', '\\x616263'), ('attachment/kept', '\\x00')`,
    );
    await rows(
      url,
      `insert into chat.job (id, name, payload) values
         (gen_random_uuid(), 'knowledge.process', '{}'),
         (gen_random_uuid(), 'memory.bot-pass', '{}')`,
    );
    const conversationId = "0196a000-0000-7000-8000-0000000000c1";
    await rows(
      url,
      `insert into chat.conversation (id, user_id, kind, model) values ('${conversationId}', 'user-1', 'assistant', 'openai:gpt-5')`,
    );
    const searched = {
      schemaVersion: 5,
      parts: [
        { type: "text", text: "Looking." },
        {
          type: "knowledge_search",
          toolCallId: "call-1",
          query: "launch",
          state: "done",
          excerpts: [{ fileId, fileName: "brief.md", chunkIndex: 0, text: "abc" }],
        },
        { type: "text", text: "It launches in May." },
      ],
    };
    await rows(
      url,
      `insert into chat.message (id, conversation_id, role, parts, status)
         values ('0196a000-0000-7000-8000-0000000000d1', '${conversationId}', 'assistant', '${JSON.stringify(searched)}', 'complete')`,
    );

    await chatFor(url).migrate();

    const tables = await rows<{ table_name: string }>(
      url,
      `select table_name from information_schema.tables
       where table_schema = 'chat' and table_name like 'knowledge%'`,
    );
    expect(tables).toEqual([]);
    const status = await rows(
      url,
      `select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'chat' and t.typname = 'knowledge_file_status'`,
    );
    expect(status).toEqual([]);
    const embeddingModel = await rows(
      url,
      `select 1 from information_schema.columns
       where table_schema = 'chat' and table_name = 'project' and column_name = 'embedding_model'`,
    );
    expect(embeddingModel).toEqual([]);
    expect(await rows(url, "select 1 from pg_extension where extname = 'vector'")).toEqual([]);
    expect(await rows(url, "select key from chat.blob")).toEqual([{ key: "attachment/kept" }]);
    expect(await rows(url, "select name from chat.job")).toEqual([{ name: "memory.bot-pass" }]);
    expect(await rows(url, "select parts from chat.message")).toEqual([
      {
        parts: {
          schemaVersion: 5,
          parts: [
            { type: "text", text: "Looking." },
            { type: "text", text: "It launches in May." },
          ],
        },
      },
    ]);
    expect(await rows(url, "select name from chat.project")).toEqual([{ name: "Launch" }]);
  });

  it("keeps the vector extension while a table outside the SDK uses it", async () => {
    const url = await scratchDatabase("k743_host_vector");
    await migrateUpTo(url, "20261022061821_bot_turn_knowledge_changes");
    await rows(url, "create table public.host_embedding (embedding vector(3))");

    await chatFor(url).migrate();

    expect(await rows(url, "select extname from pg_extension where extname = 'vector'")).toEqual([
      { extname: "vector" },
    ]);
    const tables = await rows(
      url,
      `select 1 from information_schema.tables
       where table_schema = 'chat' and table_name like 'knowledge%'`,
    );
    expect(tables).toEqual([]);
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
    expect(applied).toEqual([{ count: "62" }]);
  });

  it("gives a Conversation's tool settings empty lists by default, so existing rows read as empty", async () => {
    const url = await scratchDatabase("tool_settings");
    await chatFor(url).migrate();

    await rows(
      url,
      `insert into chat.conversation (id, user_id, kind, model)
       values ('0196a000-0000-7000-8000-000000000001', 'user-1', 'assistant', 'anthropic:claude-sonnet-5-5')`,
    );
    const stored = await rows<{ tool_settings: unknown }>(
      url,
      `select tool_settings from chat.conversation where id = '0196a000-0000-7000-8000-000000000001'`,
    );

    expect(stored).toEqual([{ tool_settings: { connections: [], allowedTools: [] } }]);
  });

  it("rejects an assistant Conversation with no Model, and lets another plugin's have none", async () => {
    const url = await scratchDatabase("kind_model");
    await chatFor(url).migrate();

    await expect(
      rows(
        url,
        `insert into chat.conversation (id, user_id, kind)
         values ('0196a000-0000-7000-8000-000000000001', 'user-1', 'assistant')`,
      ),
    ).rejects.toThrow(/conversation_assistant_model_check/);
    await rows(
      url,
      `insert into chat.conversation (id, user_id, kind)
       values ('0196a000-0000-7000-8000-000000000002', 'user-1', 'bot')`,
    );
    expect(await rows(url, "select kind, model from chat.conversation")).toEqual([
      { kind: "bot", model: null },
    ]);
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
