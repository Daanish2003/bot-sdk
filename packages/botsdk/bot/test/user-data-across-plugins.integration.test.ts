import { randomUUID } from "node:crypto";

import { count, eq, inArray, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { BlobStore } from "../src/storage";
import { createHookEmitter } from "../src/chat/hooks";
import { buildBotSdk, createBotSdk } from "../src/create-chat";
import { defineFeature } from "../src/feature";
import { schema } from "../src/storage";
import { encryptCredentials } from "../src/credentials/encryption";
import { bot, botDemonstration, botSecret, job, usage, modelSettings } from "../src/storage";
import { uuidv7 } from "../src/lib/uuidv7";
import { deleteUserData, exportUserData } from "../src/user-data";
import { sentFileBlobKey, uploadBotFile } from "../src/bot/conversation";
import { loadSecretValues, secretEncryption } from "../src/bot/safety";
import type { BotExport } from "../src/bot/conversation";
import { computerBlobKey } from "../src/computer/internal";
import { readTokens, saveTokens } from "@botsdk/mcp/server/connections";
import { mcpConnection } from "@botsdk/mcp/server/db/connection";
import { mcp } from "@botsdk/mcp";
import { profilePath } from "@botsdk/memory/server/bot-memory";
import { memorySettings } from "@botsdk/memory/server/schema";
import { listCredentials, saveCredentials, models } from "../src/models/internal";
import { insertConversation, insertMessage } from "@ai-chat/test-support/conversations";
import { createTestSdk, withPart, type TestDeps } from "@ai-chat/test-support/deps";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { insertUser, type TestUser } from "@ai-chat/test-support/users";
import { postgres } from "../src/database";

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

/** Every table of the composed schema and the mcp and memory features' with a `user_id` column, with that column. */
const userTables = [...Object.values(schema), mcpConnection, memorySettings].flatMap((value) => {
  if (!is(value, PgTable)) return [];
  const { name, columns } = getTableConfig(value);
  const column = columns.find((candidate) => candidate.name === "user_id");
  return column ? [{ name, table: value, column }] : [];
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
 * A user with a row in every table above: a Bot with a Message, an ended Demonstration, a Secret, a file uploaded and not yet sent to the Bot, a
 * Computer, the Memory switch, a Connection, credentials and usage. Returns the blob keys and ids
 * it made.
 */
async function seedEverything(
  user: TestUser,
  deps: TestDeps,
  fake: ReturnType<typeof fakeComputerProvider>,
) {
  const botConversation = await insertConversation(user, { kind: "bot" });
  const botId = uuidv7();
  await getTestDb().insert(bot).values({
    id: botId,
    userId: user.id,
    conversationId: botConversation.id,
    name: "Ada",
    model: "anthropic:claude-sonnet-5-5",
  });
  await insertMessage({
    conversationId: botConversation.id,
    role: "user",
    text: "Read this",
    active: true,
  });

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

  await deps.computer!.forUser(user.id).run("true");
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
    blobKeys: [sentFileBlobKey(upload.id), computerBlobKey(user.id)],
    ids: [user.id],
  };
}

describe("deleteUser across plugins", () => {
  it("leaves nothing of the user in any user_id table, the blob store or the jobs queue, and the other user's data untouched", async () => {
    const { store, held } = fakeBlobStore();
    const fake = fakeComputerProvider();
    const deps = createTestSdk({
      blobStore: store,
      computer: fake.provider,
      features: [mcp()],
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
      expect.arrayContaining(["conversation", "user_credentials", "bot"]),
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

  it("deletes the models plugin's rows on an instance with no feature", async () => {
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
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [testKey],
      models: {},
    });

    await sdk.users.delete({ userId: owner.id });

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
    const extra = defineFeature({
      id: "extra",
      userData: {
        delete: {
          before: async (tx, userId) => {
            const [row] = await tx
              .select({ total: count() })
              .from(memorySettings)
              .where(eq(memorySettings.userId, userId));
            // Reverse order: this feature comes after memory, so it runs first.
            seen.push(`before: settings ${row?.total}`);
            return "collected";
          },
          after: async (_userId, collected) => {
            const [row] = await getTestDb()
              .select({ total: count() })
              .from(memorySettings)
              .where(eq(memorySettings.userId, owner.id));
            seen.push(`after: ${String(collected)}, settings ${row?.total}`);
          },
        },
      },
    });

    await deleteUserData(
      createTestSdk({ computer: fakeComputerProvider().provider, features: [extra] }),
      owner.id,
    );

    expect(seen).toEqual(["before: settings 1", "after: collected, settings 0"]);
  });

  it("gives each plugin's hooks muted events, so a user delete reaches no Host hook (#265)", async () => {
    const owner = await insertUser();
    const onConversationDeleted = vi.fn();
    const announce: Parameters<typeof withPart>[1]["deleteUser"] = {
      before: async (sdk, { userId }) => {
        sdk.events.fire("onConversationDeleted", { userId, conversationId: "before" });
      },
      after: async (sdk, { userId }) => {
        sdk.events.fire("onConversationDeleted", { userId, conversationId: "after" });
      },
    };
    const hooks = createHookEmitter({ onConversationDeleted }, { error: () => {} });

    await deleteUserData(
      withPart(createTestSdk({ hooks }), { id: "announcer", deleteUser: announce }),
      owner.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onConversationDeleted).not.toHaveBeenCalled();
  });

  it("rolls everything back when a plugin's before throws, and logs an after that throws", async () => {
    const owner = await insertUser();
    await getTestDb().insert(memorySettings).values({ userId: owner.id, enabled: false });
    const failing = (where: "before" | "after") =>
      defineFeature({
        id: "failing",
        userData: {
          delete: {
            before: async () => {
              if (where === "before") throw new Error("injected failure");
            },
            after: async () => {
              if (where === "after") throw new Error("injected failure");
            },
          },
        },
      });

    const withComputer = (feature: ReturnType<typeof failing>) => ({
      computer: fakeComputerProvider().provider,
      features: [feature],
    });
    await expect(
      deleteUserData(createTestSdk(withComputer(failing("before"))), owner.id),
    ).rejects.toThrow("injected failure");
    expect(await rowsByTable(owner.id)).toMatchObject({ memory_settings: 1 });

    const logger = { error: vi.fn() };
    await deleteUserData(createTestSdk({ logger, ...withComputer(failing("after")) }), owner.id);
    expect(await rowsByTable(owner.id)).toMatchObject({ memory_settings: 0 });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("exportUser across plugins", () => {
  it("has the core's version and timestamp, and the models plugin's section, on an instance of models alone", async () => {
    const options = {
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [testKey],
      models: {},
    };
    // The Models alone, without the Bots the factory always has.
    const sdk = buildBotSdk(options, {}, [models()]).instance;

    expect(await sdk.users.export({ userId: randomUUID() })).toEqual({
      version: 2,
      exportedAt: expect.any(Date),
      // The models plugin always contributes its section.
      models: { imageModel: null },
    });
  });

  it("keeps each plugin's part under its plugin id, and no key for a plugin that is not installed", async () => {
    const extra = defineFeature({
      id: "extra",
      userData: { export: async () => ({ savedPrompts: [] }) },
    });

    const exported = await exportUserData(
      createTestSdk({ memory: false, features: [extra] }),
      randomUUID(),
    );

    expect(exported.extra).toEqual({ savedPrompts: [] });
    expect(exported.bot as BotExport).toEqual({ bots: [] });
    expect(exported).not.toHaveProperty("memory");
    expect(exported).not.toHaveProperty("savedPrompts");
  });
});

describe("sdk.users on a Host's instance", () => {
  it("exports and deletes the core's and a feature's data for the user", async () => {
    const owner = await insertUser();
    await saveCredentials(createTestSdk(), owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    const steps: string[] = [];
    const extra = defineFeature({
      id: "extra",
      userData: {
        export: async (_tx, userId) => ({ owner: userId }),
        delete: {
          before: async (_tx, userId) => void steps.push(`before ${userId}`),
          after: async (userId) => void steps.push(`after ${userId}`),
        },
      },
    });
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [testKey],
      models: {},
      features: [extra],
    });

    const exported = await sdk.users.export({ userId: owner.id });
    expect(exported).toMatchObject({
      version: 2,
      bot: { bots: [] },
      models: { imageModel: null },
      extra: { owner: owner.id },
    });

    await sdk.users.delete({ userId: owner.id });
    expect(steps).toEqual([`before ${owner.id}`, `after ${owner.id}`]);
    expect(await rowsByTable(owner.id)).toMatchObject({ user_credentials: 0 });
  });
});

describe("rotateKeys across plugins", () => {
  const keyA = "key-a-of-at-least-32-characters-long!!";
  const keyB = "key-b-of-at-least-32-characters-long!!";

  it("sums the models plugin's credentials, the bot plugin's Secrets and the mcp plugin's Connection tokens", async () => {
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
    await saveTokens(old, user.id, "docs", { accessToken: "t", tokenType: "Bearer", scope: "" });
    // A Connection whose tokens no key can read.
    await getTestDb()
      .insert(mcpConnection)
      .values({ userId: user.id, serverKey: "broken", encrypted: "v1:unknown:garbage" });
    const logger = { error: vi.fn() };
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [keyB, keyA],
      logger,
      models: {},
      features: [mcp()],
    });

    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 3, unreadable: 2 });
    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 0, unreadable: 2 });

    const onlyNew = createTestSdk({ keyEncryptionSecrets: [keyB] });
    await expect(listCredentials(onlyNew, user.id)).resolves.toHaveLength(1);
    expect((await loadSecretValues(onlyNew, user.id)).get("GITHUB_TOKEN")).toBe("ghp-test-token");
    await expect(readTokens(onlyNew, user.id, "docs")).resolves.toMatchObject({
      tokens: { accessToken: "t" },
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
