import { randomUUID } from "node:crypto";

import { count, eq, inArray, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { attachmentBlobKey, type BlobStore } from "../../../core/server/blob/store";
import { createHookEmitter } from "../../../core/server/chat/hooks";
import { createBotSdk } from "../../../core/server/create-chat";
import * as schema from "../../../core/server/db/schema";
import {
  bot,
  job,
  knowledgeFile,
  mcpConnection,
  project,
  savedPrompt,
  usage,
  userSettings,
  memorySettings,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { deleteUserData, exportUserData } from "../../../core/server/user-data";
import { knowledgeBlobKey } from "../../../plugins/assistant/server/blob-keys";
import { knowledgeJobKey } from "../../../plugins/assistant/server/knowledge/process";
import { readTokens, saveTokens } from "../../../plugins/assistant/server/mcp/connections";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { computer } from "../../../plugins/computer/server/plugin";
import { runner } from "../../../plugins/runner/server/plugin";
import { listCredentials, saveCredentials } from "../../../plugins/models/server/credentials/store";
import { models } from "../../../plugins/models/server/plugin";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk, type TestDeps } from "../../support/deps";
import { insertGeneratedImage } from "../../support/generated-images";
import { insertMemory } from "../../support/memories";
import { chatRpc } from "../../support/sdk";
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

/** Every table of the composed schema with a `user_id` column, with that column. */
const userTables = Object.values(schema).flatMap((value) => {
  if (!is(value, PgTable)) return [];
  const column = getTableConfig(value).columns.find((candidate) => candidate.name === "user_id");
  return column ? [{ name: getTableConfig(value).name, table: value, column }] : [];
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
 * A user with a row in every table that has a `user_id` column: a Conversation with an Attachment,
 * a Shared link, a Generated image and a Memory; a Project with a Conversation, a Generated image
 * and a Knowledge file whose processing job is queued; an unused Attachment; settings, a Saved
 * prompt, an MCP connection, credentials and usage; the Memory switch; a Bot; a Computer. Returns the blob keys and ids it made.
 */
async function seedEverything(user: TestUser, deps: TestDeps) {
  const conv = await insertConversation(user, { title: "Mine" });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
  await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "Hello!",
    active: true,
  });
  const used = await insertAttachment(user, { filename: "notes.txt" });
  const unused = await insertAttachment(user, { filename: "draft.txt" });
  await linkTestAttachments(question.id, [used.id]);
  for (const file of [used, unused]) {
    await deps.blobStore.put(attachmentBlobKey(file.id), new Uint8Array([1]), {
      contentType: "text/plain",
    });
  }
  await chatRpc({ user, deps }).share.upsert({ conversationId: conv.id });
  const image = await insertGeneratedImage(deps, user, conv.id);
  await insertMemory(user, { conversationId: conv.id });

  const projectId = uuidv7();
  await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Work" });
  const inProject = await insertConversation(user, { title: "In a Project", projectId });
  const projectImage = await insertGeneratedImage(deps, user, inProject.id);
  const fileId = uuidv7();
  await getTestDb().insert(knowledgeFile).values({
    id: fileId,
    userId: user.id,
    projectId,
    name: "a.md",
    mediaType: "text/markdown",
    size: 1,
  });
  await deps.blobStore.put(knowledgeBlobKey(fileId), new Uint8Array([1]), {
    contentType: "text/markdown",
  });
  await deps
    .plugin("runner")
    .enqueue("knowledge.process", { fileId }, { idempotencyKey: knowledgeJobKey(fileId) });

  const botConversation = await insertConversation(user, { kind: "bot", model: null });
  await getTestDb().insert(bot).values({
    id: uuidv7(),
    userId: user.id,
    conversationId: botConversation.id,
    name: "Ada",
    model: "anthropic:claude-sonnet-5-5",
  });

  await deps.plugin("computer").forUser(user.id).run("true");

  await getTestDb().insert(userSettings).values({ userId: user.id, instructions: "Be terse." });
  await getTestDb().insert(memorySettings).values({ userId: user.id, enabled: false });
  await getTestDb()
    .insert(savedPrompt)
    .values({ id: uuidv7(), userId: user.id, name: "review", text: "Review this." });
  await saveTokens(deps, user.id, "docs", {
    accessToken: "token",
    tokenType: "Bearer",
    scope: "read",
  });
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
      `generated-image/${image}`,
      `generated-image/${projectImage}`,
      knowledgeBlobKey(fileId),
    ],
    ids: [user.id, fileId],
  };
}

describe("deleteUser across plugins", () => {
  it("leaves nothing of the user in any user_id table, the blob store or the jobs queue, and the other user's data untouched", async () => {
    const { store, held } = fakeBlobStore();
    const deps = createTestSdk({
      blobStore: store,
      plugins: [computer({ provider: fakeComputerProvider().provider })],
    });
    const owner = await insertUser();
    const other = await insertUser();
    const own = await seedEverything(owner, deps);
    const kept = await seedEverything(other, deps);
    const before = await rowsByTable(other.id);
    // Every table with a user_id column must be seeded here, so a new one can't pass unchecked.
    expect(Object.keys(await rowsByTable(owner.id))).toEqual(
      expect.arrayContaining(["conversation", "attachment", "user_credentials", "project"]),
    );
    expect(tablesWhere(await rowsByTable(owner.id), (total) => total === 0)).toEqual([]);

    await deleteUserData(deps, owner.id);

    expect(tablesWhere(await rowsByTable(owner.id), (total) => total > 0)).toEqual([]);
    expect(own.blobKeys.filter((key) => held.has(key))).toEqual([]);
    expect(await activeJobsNaming(own.ids)).toEqual([]);
    expect(await rowsByTable(other.id)).toEqual(before);
    expect(kept.blobKeys.filter((key) => !held.has(key))).toEqual([]);
    // Their Knowledge file's processing and their Computer's sleep check.
    expect(await activeJobsNaming(kept.ids)).toHaveLength(2);
  });

  it("deletes the models plugin's rows on an instance without the assistant", async () => {
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
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [models()],
    });

    await sdk.deleteUser(owner.id);

    expect(await rowsByTable(owner.id)).toMatchObject({ user_credentials: 0, usage: 0 });
  });

  it("runs each plugin's before in the transaction and its after once committed, with what before collected", async () => {
    const owner = await insertUser();
    await getTestDb().insert(userSettings).values({ userId: owner.id, instructions: "Be terse." });
    const seen: string[] = [];
    const extra: BotSdkPlugin = {
      id: "extra",
      deleteUser: {
        before: async (_sdk, { userId, tx }) => {
          const [row] = await tx
            .select({ total: count() })
            .from(userSettings)
            .where(eq(userSettings.userId, userId));
          // Reverse dependency order: this plugin comes after the assistant, so it runs first.
          seen.push(`before: settings ${row?.total}`);
          return "collected";
        },
        after: async (_sdk, { collected }) => {
          const [row] = await getTestDb()
            .select({ total: count() })
            .from(userSettings)
            .where(eq(userSettings.userId, owner.id));
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
    await getTestDb().insert(userSettings).values({ userId: owner.id, instructions: "Be terse." });
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
    expect(await rowsByTable(owner.id)).toMatchObject({ user_settings: 1 });

    const logger = { error: vi.fn() };
    await deleteUserData(createTestSdk({ logger, plugins: [failing("after")] }), owner.id);
    expect(await rowsByTable(owner.id)).toMatchObject({ user_settings: 0 });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("exportUser across plugins", () => {
  it("has the core's version and timestamp on an instance without the assistant", async () => {
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [models()],
    });

    expect(await sdk.exportUser(randomUUID())).toEqual({
      version: 1,
      exportedAt: expect.any(Date),
    });
  });

  it("throws when two plugins give the same part of the document", async () => {
    const extra: BotSdkPlugin = { id: "extra", exportUser: async () => ({ savedPrompts: [] }) };

    await expect(exportUserData(createTestSdk({ plugins: [extra] }), randomUUID())).rejects.toThrow(
      `"savedPrompts" is exported by both "assistant" and "extra"`,
    );
  });
});

describe("rotateKeys across plugins", () => {
  const keyA = "key-a-of-at-least-32-characters-long!!";
  const keyB = "key-b-of-at-least-32-characters-long!!";

  it("sums the models plugin's credentials and the assistant's MCP tokens", async () => {
    const user = await insertUser();
    const old = createTestSdk({ keyEncryptionSecrets: [keyA] });
    await saveCredentials(old, user.id, {
      service: "openai",
      fields: { apiKey: "sk-proj-abcd" },
      hint: "…abcd",
      verified: true,
    });
    await saveTokens(old, user.id, "docs", { accessToken: "t", tokenType: "Bearer", scope: "" });
    // A Connection whose tokens no key can read.
    await getTestDb()
      .insert(mcpConnection)
      .values({ userId: user.id, serverKey: "broken", encrypted: "v1:unknown:garbage" });
    const logger = { error: vi.fn() };
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB, keyA],
      basePath: "/api/chat",
      logger,
      plugins: [models(), runner(), assistant()],
    });

    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 2, unreadable: 1 });
    await expect(sdk.rotateKeys()).resolves.toEqual({ reencrypted: 0, unreadable: 1 });

    const onlyNew = createTestSdk({ keyEncryptionSecrets: [keyB] });
    await expect(listCredentials(onlyNew, user.id)).resolves.toHaveLength(1);
    await expect(readTokens(onlyNew, user.id, "docs")).resolves.toMatchObject({
      tokens: { accessToken: "t" },
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
