import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlobStore } from "../../../core/server/blob/store";
import { createBotSdk } from "../../../core/server/create-chat";
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
    plugins: [models(), runner()],
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
  });

  it("copies each chosen Image Model into chat.model_settings (#803)", async () => {
    const url = await scratchDatabase("model_settings");
    // A database at the migration before model_settings, with two users' settings.
    await migrateUpTo(url, "20261022124724_channel_email");
    await rows(
      url,
      `insert into chat.user_settings (user_id, image_model, instructions)
       values ('user-picked', 'openai:gpt-image-2', 'Be brief'), ('user-default', null, null)`,
    );

    await chatFor(url).migrate();

    // A user with no row has the Host's default, so only a pick is copied.
    expect(
      await rows(url, "select user_id, image_model from chat.model_settings order by user_id"),
    ).toEqual([{ user_id: "user-picked", image_model: "openai:gpt-image-2" }]);
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
         ('knowledge/${fileId}', '\\x616263'), ('bot-file/kept', '\\x00')`,
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
      `insert into chat.conversation (id, user_id, kind) values ('${conversationId}', 'user-1', 'bot')`,
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
    expect(await rows(url, "select key from chat.blob")).toEqual([{ key: "bot-file/kept" }]);
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
    expect(applied).toEqual([{ count: "64" }]);
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

describe("the contract migration (#819)", () => {
  const ids = {
    assistantConversation: "0196a000-0000-7000-8000-00000000c001",
    userMessage: "0196a000-0000-7000-8000-00000000c002",
    reply: "0196a000-0000-7000-8000-00000000c003",
    project: "0196a000-0000-7000-8000-00000000c004",
    image: "0196a000-0000-7000-8000-00000000c005",
    savedPrompt: "0196a000-0000-7000-8000-00000000c006",
    attachment: "0196a000-0000-7000-8000-00000000c007",
    botConversation: "0196a000-0000-7000-8000-00000000b001",
    botMessage: "0196a000-0000-7000-8000-00000000b002",
    bot: "0196a000-0000-7000-8000-00000000b003",
    upload: "0196a000-0000-7000-8000-00000000b004",
  };
  const assistantKeys = [`attachment/${ids.attachment}`, `generated-image/${ids.image}`];
  const botKey = `bot-file/${ids.upload}`;

  /** A database at the migration before the contract, with one user's assistant and Bot data. */
  async function seeded(suffix: string) {
    const url = await scratchDatabase(suffix);
    await migrateUpTo(url, "20261023072045_bot_upload");
    await rows(
      url,
      `insert into chat.project (id, user_id, name) values ('${ids.project}', 'user-1', 'Launch');
       insert into chat.conversation (id, user_id, kind, model, project_id, pinned_at)
         values ('${ids.assistantConversation}', 'user-1', 'assistant', 'openai:gpt-5', '${ids.project}', now());
       insert into chat.message (id, conversation_id, role, parts, status)
         values ('${ids.userMessage}', '${ids.assistantConversation}', 'user', '[]', 'complete');
       insert into chat.message (id, conversation_id, parent_id, role, parts, status, rating)
         values ('${ids.reply}', '${ids.assistantConversation}', '${ids.userMessage}', 'assistant', '[]', 'complete', 'up');
       insert into chat.artifact (id, conversation_id, kind) values ('art-1', '${ids.assistantConversation}', 'html');
       insert into chat.artifact_version (artifact_id, message_id, number, title, content)
         values ('art-1', '${ids.reply}', 1, 'Page', '<p>Hi</p>');
       insert into chat.generated_image (id, user_id, message_id, media_type, width, height, size, model)
         values ('${ids.image}', 'user-1', '${ids.reply}', 'image/png', 1, 1, 1, 'openai:gpt-image-2');
       insert into chat.saved_prompt (id, user_id, name, text) values ('${ids.savedPrompt}', 'user-1', 'Brief', 'Be brief');
       insert into chat.user_settings (user_id, instructions) values ('user-1', 'Be brief');
       insert into chat.shared_link (token, conversation_id, leaf_message_id, title)
         values ('token-1', '${ids.assistantConversation}', '${ids.reply}', 'Shared');
       insert into chat.attachment (id, user_id, filename, media_type, size)
         values ('${ids.attachment}', 'user-1', 'a.txt', 'text/plain', 2);
       insert into chat.message_attachment (message_id, attachment_id, position)
         values ('${ids.userMessage}', '${ids.attachment}', 0);
       insert into chat.conversation (id, user_id, kind) values ('${ids.botConversation}', 'user-1', 'bot');
       insert into chat.message (id, conversation_id, role, parts, status)
         values ('${ids.botMessage}', '${ids.botConversation}', 'user', '[]', 'complete');
       insert into chat.bot (id, user_id, conversation_id, name, model)
         values ('${ids.bot}', 'user-1', '${ids.botConversation}', 'Ada', 'openai:gpt-5');
       insert into chat.bot_upload (id, user_id, name, media_type, size, created_at)
         values ('${ids.upload}', 'user-1', 'notes.txt', 'text/plain', 2, now());
       insert into chat.mcp_connection (user_id, server_key, encrypted) values ('user-1', 'linear', 'sealed');
       insert into chat.model_settings (user_id, image_model) values ('user-1', 'openai:gpt-image-2');
       insert into chat.blob (key, bytes) values
         ('${assistantKeys[0]}', '\\x6869'), ('${assistantKeys[1]}', '\\x00'), ('${botKey}', '\\x6869'),
         ('attachment/stray', '\\x00');`,
    );
    return url;
  }

  it("deletes the assistant's data and schema, and keeps every Bot row, the Connection and the Image Model", async () => {
    const url = await seeded("contract");

    await chatFor(url).migrate();

    const tables = await rows<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema = 'chat'",
    );
    const dropped = [
      "project",
      "artifact",
      "artifact_version",
      "generated_image",
      "saved_prompt",
      "user_settings",
      "shared_link",
      "attachment",
      "message_attachment",
    ];
    expect(tables.map((row) => row.table_name).filter((name) => dropped.includes(name))).toEqual(
      [],
    );
    const enums = await rows<{ typname: string }>(
      url,
      `select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'chat' and t.typname in ('reasoning_effort', 'artifact_kind', 'message_rating')`,
    );
    expect(enums).toEqual([]);
    const columns = await rows<{ table_name: string; column_name: string }>(
      url,
      `select table_name, column_name from information_schema.columns
       where table_schema = 'chat' and table_name in ('conversation', 'message')
       order by table_name, column_name`,
    );
    expect(columns).toEqual([
      ...[
        "active_leaf_id",
        "created_at",
        "id",
        "kind",
        "last_message_at",
        "last_seq",
        "title",
        "updated_at",
        "user_id",
      ].map((column_name) => ({ table_name: "conversation", column_name })),
      ...[
        "conversation_id",
        "created_at",
        "error",
        "error_reason",
        "id",
        "parent_id",
        "parts",
        "role",
        "status",
      ].map((column_name) => ({ table_name: "message", column_name })),
    ]);
    expect(
      await rows(
        url,
        `select conname from pg_constraint where conname = 'conversation_assistant_model_check'`,
      ),
    ).toEqual([]);
    const indexes = await rows<{ indexname: string }>(
      url,
      `select indexname from pg_indexes
       where schemaname = 'chat' and tablename in ('conversation', 'message') order by indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      "conversation_pkey",
      "conversation_user_id_last_message_at_idx",
      "message_conversation_id_parent_id_idx",
      "message_pkey",
    ]);
    const statuses = await rows<{ enumlabel: string }>(
      url,
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'chat' and t.typname = 'message_status' order by e.enumsortorder`,
    );
    expect(statuses.map((row) => row.enumlabel)).toContain("awaiting_approval");

    expect(await rows(url, "select id, kind from chat.conversation")).toEqual([
      { id: ids.botConversation, kind: "bot" },
    ]);
    expect(await rows(url, "select id from chat.message")).toEqual([{ id: ids.botMessage }]);
    expect(await rows(url, "select id, name from chat.bot")).toEqual([
      { id: ids.bot, name: "Ada" },
    ]);
    expect(await rows(url, "select id from chat.bot_upload")).toEqual([{ id: ids.upload }]);
    expect(await rows(url, "select server_key, encrypted from chat.mcp_connection")).toEqual([
      { server_key: "linear", encrypted: "sealed" },
    ]);
    expect(await rows(url, "select user_id, image_model from chat.model_settings")).toEqual([
      { user_id: "user-1", image_model: "openai:gpt-image-2" },
    ]);
  });

  it("deletes every attachment/ and generated-image/ byte in chat.blob, strays too, and keeps the Bot's", async () => {
    const url = await seeded("contract_blobs");

    await chatFor(url).migrate();

    expect(await rows(url, "select key from chat.blob")).toEqual([{ key: botKey }]);
  });

  it("deletes the assistant's bytes from the Host's own blob store", async () => {
    const url = await seeded("contract_store");
    const deleted: string[] = [];
    const store: BlobStore = {
      put: async () => {},
      get: async () => null,
      delete: async (keys) => {
        deleted.push(...keys);
      },
    };

    const chat = createBotSdk({
      databaseUrl: url,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath: "/api/chat",
      blobStore: store,
      plugins: [models(), runner()],
    });

    await chat.migrate();

    expect(deleted.sort()).toEqual(assistantKeys);
    // Only once: a later run finds the tables gone and deletes nothing.
    await chat.migrate();
    expect(deleted).toHaveLength(2);
  });

  it("keeps deleting the other keys from the Host's store when one delete fails, and tells the Host's logger", async () => {
    const url = await seeded("contract_store_fails");
    const deleted: string[] = [];
    const store: BlobStore = {
      put: async () => {},
      get: async () => null,
      delete: async (keys) => {
        if (keys.includes(assistantKeys[0]!)) throw new Error("S3 is down");
        deleted.push(...keys);
      },
    };
    const logger = { error: vi.fn() };

    await createBotSdk({
      databaseUrl: url,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath: "/api/chat",
      blobStore: store,
      logger,
      plugins: [models(), runner()],
    }).migrate();

    expect(deleted).toEqual([assistantKeys[1]]);
    expect(logger.error).toHaveBeenCalledWith("1 of the assistant's 2 blobs are still stored");
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
