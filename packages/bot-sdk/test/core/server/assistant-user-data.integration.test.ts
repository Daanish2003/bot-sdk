import { randomUUID } from "node:crypto";

import { count, eq, inArray, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { attachmentBlobKey, type BlobStore } from "../../../core/server/blob/store";
import { createBotSdk } from "../../../core/server/create-chat";
import * as schema from "../../../core/server/db/schema";
import {
  bot,
  botDemonstration,
  botSecret,
  job,
  mcpConnection,
  project,
  savedPrompt,
  usage,
  userSettings,
  memorySettings,
  modelSettings,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { deleteUserData, exportUserData } from "../../../core/server/user-data";
import { readTokens, saveTokens } from "../../../plugins/assistant/server/mcp/connections";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { sentFileBlobKey, uploadBotFile } from "../../../plugins/bot/server/files";
import { bot as botPlugin } from "../../../plugins/bot/server/plugin";
import { computer, computerBlobKey } from "../../../plugins/computer/server/plugin";
import { profilePath } from "../../../plugins/memory/server/bot-memory";
import { runner } from "../../../plugins/runner/server/plugin";
import { listCredentials, saveCredentials } from "../../../plugins/models/server/credentials/store";
import { models } from "../../../plugins/models/server/plugin";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { chatRpc, createTestSdk, type TestDeps } from "../../support/assistant";
import { insertGeneratedImage } from "../../support/generated-images";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { fakeComputerProvider } from "../../plugins/computer/server/fake-provider";
import { insertUser, type TestUser } from "../../support/users";

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
 * a Shared link and a Generated image; a Project with a Conversation and a Generated image; an
 * unused Attachment; settings, a Saved
 * prompt, an MCP connection, credentials and usage; the Memory switch; a Bot; a file uploaded and
 * not yet sent to the Bot; a Computer. Returns the blob keys and ids it made.
 */
async function seedEverything(
  user: TestUser,
  deps: TestDeps,
  fake: ReturnType<typeof fakeComputerProvider>,
) {
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

  const projectId = uuidv7();
  await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Work" });
  const inProject = await insertConversation(user, { title: "In a Project", projectId });
  const projectImage = await insertGeneratedImage(deps, user, inProject.id);

  const botConversation = await insertConversation(user, { kind: "bot", model: null });
  const botId = uuidv7();
  await getTestDb().insert(bot).values({
    id: botId,
    userId: user.id,
    conversationId: botConversation.id,
    name: "Ada",
    model: "anthropic:claude-sonnet-5-5",
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

  await deps.plugin("computer").forUser(user.id).run("true");
  // The Bot's memory files, on the disk of the sandbox the run above made, and the Computer's archive.
  fake.files.set(profilePath(botId), new TextEncoder().encode("- Lives in Berlin\n"));
  await deps.blobStore.put(computerBlobKey(user.id), new Uint8Array([1]), {
    contentType: "application/gzip",
  });

  await getTestDb().insert(userSettings).values({ userId: user.id, instructions: "Be terse." });
  await getTestDb().insert(memorySettings).values({ userId: user.id, enabled: false });
  await getTestDb()
    .insert(modelSettings)
    .values({ userId: user.id, imageModel: "openai:gpt-image-2" });
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
      sentFileBlobKey(upload.id),
      computerBlobKey(user.id),
    ],
    ids: [user.id],
  };
}

describe("deleteUser across plugins, the assistant among them", () => {
  it("leaves nothing of the user in any user_id table, the blob store or the jobs queue, and the other user's data untouched", async () => {
    const { store, held } = fakeBlobStore();
    const fake = fakeComputerProvider();
    const deps = createTestSdk({
      blobStore: store,
      plugins: [botPlugin(), computer({ provider: fake.provider })],
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
      expect.arrayContaining(["conversation", "attachment", "user_credentials", "project"]),
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
});

describe("exportUser across plugins, the assistant among them", () => {
  it("keeps each plugin's part under its plugin id, and no key for a plugin that is not installed", async () => {
    const extra: BotSdkPlugin = { id: "extra", exportUser: async () => ({ savedPrompts: [] }) };

    const exported = await exportUserData(
      createTestSdk({ memory: false, plugins: [extra] }),
      randomUUID(),
    );

    expect(exported.extra).toEqual({ savedPrompts: [] });
    expect(exported.assistant).toMatchObject({ savedPrompts: [], conversations: [] });
    expect(exported).not.toHaveProperty("memory");
    expect(exported).not.toHaveProperty("savedPrompts");
  });
});

describe("rotateKeys across plugins, the assistant among them", () => {
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
