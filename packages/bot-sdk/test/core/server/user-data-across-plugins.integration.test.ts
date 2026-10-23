import { randomUUID } from "node:crypto";

import { count, eq, inArray, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { attachmentBlobKey, type BlobStore } from "../../../core/server/blob/store";
import { createHookEmitter } from "../../../core/server/chat/hooks";
import { createBotSdk } from "../../../core/server/create-chat";
import * as schema from "../../../core/server/db/schema";
import { encryptCredentials } from "../../../core/server/credentials/encryption";
import {
  bot,
  botDemonstration,
  botSecret,
  job,
  usage,
  memorySettings,
  modelSettings,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { deleteUserData, exportUserData } from "../../../core/server/user-data";
import { sentFileBlobKey, uploadBotFile } from "../../../plugins/bot/server/files";
import { bot as botPlugin } from "../../../plugins/bot/server/plugin";
import { loadSecretValues, secretEncryption } from "../../../plugins/bot/server/secret-values";
import type { BotExport } from "../../../plugins/bot/server/store";
import { computer, computerBlobKey } from "../../../plugins/computer/server/plugin";
import { saveTokens } from "../../../plugins/mcp/server/connections";
import { mcp } from "../../../plugins/mcp/server/plugin";
import { profilePath } from "../../../plugins/memory/server/bot-memory";
import { runner } from "../../../plugins/runner/server/plugin";
import { listCredentials, saveCredentials } from "../../../plugins/models/server/credentials/store";
import { models } from "../../../plugins/models/server/plugin";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk, type TestDeps } from "../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { fakeComputerProvider } from "../../plugins/computer/server/fake-provider";
import { insertUser, type TestUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";

/** A blob store in memory, with the keys it holds. */
function fakeBlobStore() {
  const held = new Map<string, Uint8Array>();
  const store: BlobStore = {
    put: async (key, bytes) => void held.set(key, bytes),
    get: async (key) => held.get(key) ?? null,
    delete: async (keys) => {
      for (const key of keys) held.delete(key);
    },
  };
  return { store, held };
}

/**
 * The assistant's tables with a `user_id` column. The instances here don't install it;
 * `assistant-user-data.integration.test.ts` seeds and checks them with the assistant installed.
 */
const assistantTables = ["generated_image", "project", "saved_prompt", "user_settings"];

/** Every other table of the composed schema with a `user_id` column, with that column. */
const userTables = Object.values(schema).flatMap((value) => {
  if (!is(value, PgTable)) return [];
  const { name, columns } = getTableConfig(value);
  const column = columns.find((candidate) => candidate.name === "user_id");
  return column && !assistantTables.includes(name) ? [{ name, table: value, column }] : [];
});

/** The user's row count in every table with a `user_id` column, by table name. */
async function rowsByTable(userId: string) {
  const counts: Record<string, number> = {};
  for (const { name, table, column } of userTables) {
    const [row] = await getTestDb()
      .select({ total: count() })
      .from(table)
      .where(eq(column, userId));
    counts[name] = row?.total ?? 0;
  }
  return counts;
}

/** The names of the tables whose count matches. */
const tablesWhere = (counts: Record<string, number>, match: (total: number) => boolean) =>
  Object.keys(counts).filter((name) => match(counts[name]!));

/** The active jobs that name any of `ids` in their payload. */
async function activeJobsNaming(ids: string[]) {
  const rows = await getTestDb()
    .select({ payload: job.payload })
    .from(job)
    .where(inArray(job.status, ["queued", "running"]));
  return rows.filter((row) => ids.some((id) => JSON.stringify(row.payload).includes(id)));
}

/**
 * A user with a row in every table above: a Bot whose Conversation has an Attachment, an unused
 * Attachment, an ended Demonstration, a Secret, a file uploaded and not yet sent to the Bot, a
 * Computer, the Memory switch, a Connection, credentials and usage. Returns the blob keys and ids
 * it made.
 */
async function seedEverything(
  user: TestUser,
  deps: TestDeps,
  fake: ReturnType<typeof fakeComputerProvider>,
) {
  const botConversation = await insertConversation(user, { kind: "bot", model: null });
  const botId = uuidv7();
  await getTestDb().insert(bot).values({
    id: botId,
    userId: user.id,
    conversationId: botConversation.id,
    name: "Ada",
    model: "anthropic:claude-sonnet-5-5",
  });
  const said = await insertMessage({
    conversationId: botConversation.id,
    role: "user",
    text: "Read this",
    active: true,
  });
  const used = await insertAttachment(user, { filename: "notes.txt" });
  const unused = await insertAttachment(user, { filename: "draft.txt" });
  await linkTestAttachments(said.id, [used.id]);
  for (const file of [used, unused]) {
    await deps.blobStore.put(attachmentBlobKey(file.id), new Uint8Array([1]), {
      contentType: "text/plain",
    });
  }

  // An ended Demonstration, so it holds no Screen.
  await getTestDb().insert(botDemonstration).values({
    id: uuidv7(),
    botId,
    userId: user.id,
    conversationId: botConversation.id,
    goal: "Copy the payouts",
    inputs: [],
    state: "cancelled",
    screen: 1,
    startedAt: new Date(),
    endedAt: new Date(),
  });

  await getTestDb().insert(botSecret).values({
    userId: user.id,
    name: "GITHUB_TOKEN",
    encrypted: "v2.x.x.x.x",
    createdAt: new Date(),
  });

  const upload = await uploadBotFile(
    deps,
    user.id,
    new File(["milk, eggs"], "list.txt", { type: "text/plain" }),
  );

  await deps.plugin("computer").forUser(user.id).run("true");
  // The Bot's memory files, on the disk of the sandbox the run above made, and the Computer's archive.
  fake.files.set(profilePath(botId), new TextEncoder().encode("- Lives in Berlin\n"));
  await deps.blobStore.put(computerBlobKey(user.id), new Uint8Array([1]), {
    contentType: "application/gzip",
  });

  await getTestDb().insert(memorySettings).values({ userId: user.id, enabled: false });
  await saveTokens(deps, user.id, "linear", { accessToken: "t", tokenType: "Bearer", scope: "" });
  await getTestDb()
    .insert(modelSettings)
    .values({ userId: user.id, imageModel: "openai:gpt-image-2" });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId: user.id,
    kind: "run",
    model: "anthropic:claude-sonnet-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 1,
    estimated: false,
  });
  return {
    blobKeys: [
      attachmentBlobKey(used.id),
      attachmentBlobKey(unused.id),
      sentFileBlobKey(upload.id),
      computerBlobKey(user.id),
    ],
    ids: [user.id],
  };
}

describe("deleteUser across plugins", () => {
  it("leaves nothing of the user in any user_id table, the blob store or the jobs queue, and the other user's data untouched", async () => {
    const { store, held } = fakeBlobStore();
    const fake = fakeComputerProvider();
    const deps = createTestSdk({
      blobStore: store,
      plugins: [botPlugin(), computer({ provider: fake.provider }), mcp()],
    });
    const owner = await insertUser();
    const other = await insertUser();
    const own = await seedEverything(owner, deps, fake);
    // The owner's Computer is the first sandbox the run made; the Bot's files are on its disk.
    const ownSandbox = fake.callsOf("create")[0]?.sandboxId;
    const kept = await seedEverything(other, deps, fake);
    const before = await rowsByTable(other.id);
    // Every table with a user_id column must be seeded here, so a new one can't pass unchecked.
    expect(Object.keys(await rowsByTable(owner.id))).toEqual(
      expect.arrayContaining(["conversation", "attachment", "user_credentials", "bot"]),
    );
    expect(tablesWhere(await rowsByTable(owner.id), (total) => total === 0)).toEqual([]);

    await deleteUserData(deps, owner.id);

    expect(tablesWhere(await rowsByTable(owner.id), (total) => total > 0)).toEqual([]);
    expect(own.blobKeys.filter((key) => held.has(key))).toEqual([]);
    expect(await activeJobsNaming(own.ids)).toEqual([]);
    expect(await rowsByTable(other.id)).toEqual(before);
    expect(kept.blobKeys.filter((key) => !held.has(key))).toEqual([]);
    // Their Computer's sandbox, with the Bot's memory files on its disk, is killed.
    expect(ownSandbox).toEqual(expect.any(String));
    expect(fake.callsOf("kill-sandbox").map((call) => call.sandboxId)).toEqual([ownSandbox]);
    // Their Computer's sleep check.
    expect(await activeJobsNaming(kept.ids)).toHaveLength(1);
  });

  it("deletes the models plugin's rows on an instance of models alone", async () => {
    const owner = await insertUser();
    await saveCredentials(createTestSdk(), owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: owner.id,
      kind: "run",
      model: "anthropic:claude-sonnet-5-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
      estimated: false,
    });
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: owner.id, imageModel: "openai:gpt-image-2" });
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [models()],
    });

    await sdk.deleteUser(owner.id);

    expect(await rowsByTable(owner.id)).toMatchObject({
      user_credentials: 0,
      model_settings: 0,
      usage: 0,
    });
  });

  it("runs each plugin's before in the transaction and its after once committed, with what before collected", async () => {
    const owner = await insertUser();
    await getTestDb().insert(memorySettings).values({ userId: owner.id, enabled: false });
    const seen: string[] = [];
    const extra: BotSdkPlugin = {
      id: "extra",
      deleteUser: {
        before: async (_sdk, { userId, tx }) => {
          const [row] = await tx
            .select({ total: count() })
            .from(memorySettings)
            .where(eq(memorySettings.userId, userId));
          // Reverse dependency order: this plugin comes after memory, so it runs first.
          seen.push(`before: settings ${row?.total}`);
          return "collected";
        },
        after: async (_sdk, { collected }) => {
          const [row] = await getTestDb()
            .select({ total: count() })
            .from(memorySettings)
            .where(eq(memorySettings.userId, owner.id));
          seen.push(`after: ${String(collected)}, settings ${row?.total}`);
        },
      },
    };

    await deleteUserData(createTestSdk({ plugins: [extra] }), owner.id);

    expect(seen).toEqual(["before: settings 1", "after: collected, settings 0"]);
  });

  it("gives each plugin's hooks muted events, so a user delete reaches no Host hook (#265)", async () => {
    const owner = await insertUser();
    const onConversationDeleted = vi.fn();
    const announce: BotSdkPlugin["deleteUser"] = {
      before: async (sdk, { userId }) => {
        sdk.events.fire("onConversationDeleted", { userId, conversationId: "before" });
      },
      after: async (sdk, { userId }) => {
        sdk.events.fire("onConversationDeleted", { userId, conversationId: "after" });
      },
    };
    const hooks = createHookEmitter({ onConversationDeleted }, { error: () => {} });

    await deleteUserData(
      createTestSdk({ hooks, plugins: [{ id: "announcer", deleteUser: announce }] }),
      owner.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onConversationDeleted).not.toHaveBeenCalled();
  });

  it("rolls everything back when a plugin's before throws, and logs an after that throws", async () => {
    const owner = await insertUser();
    await getTestDb().insert(memorySettings).values({ userId: owner.id, enabled: false });
    const failing = (where: "before" | "after"): BotSdkPlugin => ({
      id: "failing",
      deleteUser: {
        before: async () => {
          if (where === "before") throw new Error("injected failure");
        },
        after: async () => {
          if (where === "after") throw new Error("injected failure");
        },
      },
    });

    await expect(
      deleteUserData(createTestSdk({ plugins: [failing("before")] }), owner.id),
    ).rejects.toThrow("injected failure");
    expect(await rowsByTable(owner.id)).toMatchObject({ memory_settings: 1 });

    const logger = { error: vi.fn() };
    await deleteUserData(createTestSdk({ logger, plugins: [failing("after")] }), owner.id);
    expect(await rowsByTable(owner.id)).toMatchObject({ memory_settings: 0 });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("exportUser across plugins", () => {
  it("has the core's version and timestamp, and the models plugin's section, on an instance of models alone", async () => {
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [models()],
    });

    expect(await sdk.exportUser(randomUUID())).toEqual({
      version: 2,
      exportedAt: expect.any(Date),
      // The models plugin always contributes its section.
      models: { imageModel: null },
    });
  });

  it("keeps each plugin's part under its plugin id, and no key for a plugin that is not installed", async () => {
    const extra: BotSdkPlugin = { id: "extra", exportUser: async () => ({ savedPrompts: [] }) };

    const exported = await exportUserData(
      createTestSdk({ memory: false, plugins: [botPlugin(), extra] }),
      randomUUID(),
    );

    expect(exported.extra).toEqual({ savedPrompts: [] });
    expect(exported.bot as BotExport).toEqual({ bots: [] });
    expect(exported).not.toHaveProperty("memory");
    expect(exported).not.toHaveProperty("savedPrompts");
  });
});

describe("rotateKeys across plugins", () => {
  const keyA = "key-a-of-at-least-32-characters-long!!";
  const keyB = "key-b-of-at-least-32-characters-long!!";

  it("sums the models plugin's credentials and the bot plugin's Secrets", async () => {
    const user = await insertUser();
    const old = createTestSdk({ keyEncryptionSecrets: [keyA] });
    await saveCredentials(old, user.id, {
      service: "openai",
      fields: { apiKey: "sk-proj-abcd" },
      hint: "…abcd",
      verified: true,
    });
    await getTestDb()
      .insert(botSecret)
      .values([
        {
          userId: user.id,
          name: "GITHUB_TOKEN",
          encrypted: encryptCredentials(
            { value: "ghp-test-token" },
            secretEncryption(old, user.id, "GITHUB_TOKEN"),
          ),
          createdAt: new Date(),
        },
        // A Secret no key can read.
        { userId: user.id, name: "BROKEN", encrypted: "v1:unknown:garbage", createdAt: new Date() },
      ]);
    const logger = { error: vi.fn() };
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB, keyA],
      basePath: "/api/chat",
      logger,
      plugins: [models(), runner(), botPlugin()],
    });

    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 2, unreadable: 1 });
    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 0, unreadable: 1 });

    const onlyNew = createTestSdk({ keyEncryptionSecrets: [keyB] });
    await expect(listCredentials(onlyNew, user.id)).resolves.toHaveLength(1);
    expect((await loadSecretValues(onlyNew, user.id)).get("GITHUB_TOKEN")).toBe("ghp-test-token");
    expect(logger.error).toHaveBeenCalled();
  });
});
