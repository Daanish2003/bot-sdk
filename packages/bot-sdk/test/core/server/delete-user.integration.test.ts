import { randomUUID } from "node:crypto";

import { EventType } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../core/server/assistant";
import { deleteAllConversations, deleteUserData } from "../../../core/server/delete-user";
import { deleteConversation } from "../../../core/server/chat/store";
import { saveCredentials } from "../../../core/server/credentials/store";
import { START } from "../../../core/server/chat/run-streams";
import { artifact, artifactVersion } from "../../../core/server/db/schema/artifact";
import { attachment, messageAttachment } from "../../../core/server/db/schema/attachment";
import { knowledgeBlobKey } from "../../../core/server/blob/store";
import { blob } from "../../../core/server/db/schema/blob";
import { conversation, message, project } from "../../../core/server/db/schema/chat";
import { job } from "../../../core/server/db/schema/job";
import { knowledgeFile } from "../../../core/server/db/schema/knowledge";
import { knowledgeJobKey } from "../../../core/server/knowledge/process";
import { userCredentials } from "../../../core/server/db/schema/credentials";
import { savedPrompt } from "../../../core/server/db/schema/saved-prompt";
import { sharedLink } from "../../../core/server/db/schema/share";
import { userSettings } from "../../../core/server/db/schema/settings";
import { usage } from "../../../core/server/db/schema/usage";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { createFakeAdapter, text } from "../../support/fake-adapter";
import { createTestChat } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";

/** A user with one of everything the SDK keeps for them. */
async function seedOwner(user: TestUser) {
  const conv = await insertConversation(user, { title: "Mine" });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
  const reply = await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "Hello!",
    active: true,
  });
  const file = await insertAttachment(user, { filename: "notes.txt" });
  await linkTestAttachments(question.id, [file.id]);
  const deps = createTestSdk();
  const link = await createTestChat({ user, deps }).rpc.share.upsert({ conversationId: conv.id });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await getTestDb()
    .insert(userSettings)
    .values({ userId: user.id, backgroundModel: "anthropic:x", instructions: "Be terse." });
  await getTestDb().insert(project).values({ id: uuidv7(), userId: user.id, name: "Work" });
  await getTestDb()
    .insert(savedPrompt)
    .values({ id: uuidv7(), userId: user.id, name: "review", text: "Review this." });
  const artifactId = `art-${randomUUID().slice(0, 8)}`;
  await getTestDb()
    .insert(artifact)
    .values({ id: artifactId, conversationId: conv.id, kind: "markdown" });
  await getTestDb().insert(artifactVersion).values({
    artifactId,
    messageId: reply.id,
    number: 1,
    title: "Notes",
    language: null,
    content: "# Notes",
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
  return { conv, question, reply, file, link, deps, artifactId };
}

/** Every row the SDK holds for the user, by table, counted through the user or their Conversations. */
async function ownedRows(userId: string) {
  const db = getTestDb();
  const ownConversations = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.userId, userId));
  const ownAttachments = db
    .select({ id: attachment.id })
    .from(attachment)
    .where(eq(attachment.userId, userId));
  const ownBlobKeys = db
    .select({ key: sql<string>`'attachment/' || ${attachment.id}` })
    .from(attachment)
    .where(eq(attachment.userId, userId));
  const count = async (query: Promise<unknown[]>) => (await query).length;
  return {
    conversations: await count(
      db.select().from(conversation).where(eq(conversation.userId, userId)),
    ),
    messages: await count(
      db.select().from(message).where(inArray(message.conversationId, ownConversations)),
    ),
    sharedLinks: await count(
      db.select().from(sharedLink).where(inArray(sharedLink.conversationId, ownConversations)),
    ),
    attachments: await count(db.select().from(attachment).where(eq(attachment.userId, userId))),
    attachmentBlobs: await count(db.select().from(blob).where(inArray(blob.key, ownBlobKeys))),
    messageAttachments: await count(
      db
        .select()
        .from(messageAttachment)
        .where(inArray(messageAttachment.attachmentId, ownAttachments)),
    ),
    credentials: await count(
      db.select().from(userCredentials).where(eq(userCredentials.userId, userId)),
    ),
    settings: await count(db.select().from(userSettings).where(eq(userSettings.userId, userId))),
    projects: await count(db.select().from(project).where(eq(project.userId, userId))),
    savedPrompts: await count(db.select().from(savedPrompt).where(eq(savedPrompt.userId, userId))),
    usage: await count(db.select().from(usage).where(eq(usage.userId, userId))),
    artifacts: await count(
      db.select().from(artifact).where(inArray(artifact.conversationId, ownConversations)),
    ),
    artifactVersions: await count(
      db
        .select()
        .from(artifactVersion)
        .where(
          inArray(
            artifactVersion.artifactId,
            db
              .select({ id: artifact.id })
              .from(artifact)
              .where(inArray(artifact.conversationId, ownConversations)),
          ),
        ),
    ),
  };
}

const emptyRows = {
  conversations: 0,
  messages: 0,
  sharedLinks: 0,
  attachments: 0,
  attachmentBlobs: 0,
  messageAttachments: 0,
  credentials: 0,
  settings: 0,
  projects: 0,
  savedPrompts: 0,
  usage: 0,
  artifacts: 0,
  artifactVersions: 0,
};

describe("Artifacts go with the Message, Conversation or user that owns them", () => {
  it("deleting a Message removes the versions it wrote and keeps the others", async () => {
    const owner = await insertUser();
    const { conv, reply, artifactId } = await seedOwner(owner);
    const update = await insertMessage({
      conversationId: conv.id,
      parentId: reply.id,
      role: "assistant",
      text: "Updated",
      active: true,
    });
    await getTestDb().insert(artifactVersion).values({
      artifactId,
      messageId: update.id,
      number: 2,
      title: "Notes",
      language: null,
      content: "# Notes v2",
    });

    await getTestDb().delete(message).where(eq(message.id, update.id));

    const versions = await getTestDb()
      .select({ number: artifactVersion.number, messageId: artifactVersion.messageId })
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId));
    expect(versions).toEqual([{ number: 1, messageId: reply.id }]);
    expect(
      await getTestDb().select().from(artifact).where(eq(artifact.id, artifactId)),
    ).toHaveLength(1);
  });

  it("deleting a Conversation leaves no Artifact or version of it", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const { conv } = await seedOwner(owner);
    await seedOwner(other);
    const before = await ownedRows(other.id);

    expect(await deleteConversation(createTestSdk(), owner.id, conv.id)).toBe(true);

    expect(await ownedRows(owner.id)).toMatchObject({ artifacts: 0, artifactVersions: 0 });
    expect(await ownedRows(other.id)).toEqual(before);
  });

  it("deleting all Conversations leaves no Artifact or version of the user's", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner);
    await seedOwner(other);
    const before = await ownedRows(other.id);

    await deleteAllConversations(createTestSdk(), owner.id);

    expect(await ownedRows(owner.id)).toMatchObject({ artifacts: 0, artifactVersions: 0 });
    expect(await ownedRows(other.id)).toEqual(before);
    expect(before.artifactVersions).toBe(1);
  });
});

describe("deleteUserData", () => {
  it("removes every row the user owns and leaves other users' rows alone", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner);
    const kept = await seedOwner(other);
    const before = await ownedRows(other.id);

    await deleteUserData(createTestSdk(), owner.id);

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
    expect(await ownedRows(other.id)).toEqual(before);
    expect(before.conversations).toBe(1);
    expect(
      await createTestChat({ user: other, deps: kept.deps }).rpc.share.get({
        token: kept.link.token,
      }),
    ).toMatchObject({ title: "Mine" });
  });

  it("is idempotent, and an unknown id succeeds", async () => {
    const owner = await insertUser();
    await seedOwner(owner);
    const deps = createTestSdk();

    await deleteUserData(deps, owner.id);
    await deleteUserData(deps, owner.id);
    await deleteUserData(deps, randomUUID());

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
  });

  it("removes a user's Shared link: its read is not found", async () => {
    const owner = await insertUser();
    const { link, deps } = await seedOwner(owner);

    await deleteUserData(deps, owner.id);

    await expect(
      createTestChat({ user: null, deps }).rpc.share.get({ token: link.token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rolls everything back when a step fails mid-way", async () => {
    const owner = await insertUser();
    const { conv, file } = await seedOwner(owner);
    // The last step deletes user_settings, so a trigger that fails there fails after every other step.
    await getTestDb().execute(sql`
      create function chat.fail_settings_delete() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$`);
    await getTestDb().execute(sql`
      create trigger fail_settings_delete before delete on chat.user_settings
      for each row execute function chat.fail_settings_delete()`);
    try {
      await expect(deleteUserData(createTestSdk(), owner.id)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("injected failure") },
      });
    } finally {
      await getTestDb().execute(sql`drop function chat.fail_settings_delete() cascade`);
    }

    const rows = await ownedRows(owner.id);
    expect(rows.conversations).toBe(1);
    expect(rows.messages).toBe(2);
    expect(rows.sharedLinks).toBe(1);
    expect(rows.attachments).toBe(1);
    expect(rows.messageAttachments).toBe(1);
    expect(rows.credentials).toBe(1);
    expect(rows.settings).toBe(1);
    expect(rows.projects).toBe(1);
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id)),
    ).toHaveLength(1);
    expect(
      await getTestDb().select().from(attachment).where(eq(attachment.id, file.id)),
    ).toHaveLength(1);
  });

  describe("a live Run", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is stopped before its rows go, and writes nothing after", async () => {
      const owner = await insertUser();
      const conv = await insertConversation(owner, { title: "Live" });
      const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
      await saveCredentials(createTestSdk(), owner.id, {
        service: "anthropic",
        fields: { apiKey: "sk-ant-test-key" },
        hint: "…-key",
        verified: true,
      });
      // Held until the test releases it, so the Run is still live when the user is deleted.
      const fake = createFakeAdapter({ rounds: [text("Hel", "lo")], manual: true });
      const deps = createTestSdk({ adapterFor: () => fake.adapter });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createTestChat({ user: owner, deps });
      // A regenerate starts the Run through the handler, as a Host's POST does. The reply is not read.
      const started = await client.fetch(
        new Request(client.chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [],
            forwardedProps: {
              conversationId: conv.id,
              parentId: question.id,
              attachmentIds: [],
              model: "anthropic:claude-sonnet-5-5",
              webSearch: false,
            },
          }),
        }),
      );
      expect(started.status).toBe(200);
      const [reply] = await getTestDb()
        .select()
        .from(message)
        .where(and(eq(message.conversationId, conv.id), eq(message.status, "streaming")));
      if (!reply) throw new Error("The Run did not start a streaming Message");
      await fake.release(1);

      await deleteUserData(deps, owner.id);

      // The log ends with a terminal chunk, so a reader does not reconnect and start the Run again.
      const chunks = [];
      for await (const entry of deps.runStreams.read(reply.id, START)) chunks.push(entry.chunk);
      expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      // The owner's last writes landed on deleted rows, so no Message came back and nothing failed.
      expect(await getTestDb().select().from(message).where(eq(message.id, reply.id))).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});

describe("createBotSdk().deleteUser", () => {
  it("removes the user's rows through the Host's entry point", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner);
    await seedOwner(other);
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [assistant()],
    });

    await chat.deleteUser(owner.id);

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
    expect((await ownedRows(other.id)).conversations).toBe(1);
    expect(
      await getTestDb()
        .select()
        .from(conversation)
        .where(and(eq(conversation.userId, other.id))),
    ).toHaveLength(1);
  });
});

describe("deleteUserData, Temporary Conversations", () => {
  it("removes the user's Temporary Conversations with their Messages", async () => {
    const owner = await insertUser();
    const temporary = await insertConversation(owner, { temporary: true });
    await insertMessage({ conversationId: temporary.id, role: "user", text: "Private" });

    await deleteUserData(createTestSdk(), owner.id);

    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, temporary.id)),
    ).toEqual([]);
    expect(
      await getTestDb().select().from(message).where(eq(message.conversationId, temporary.id)),
    ).toEqual([]);
  });
});

describe("deleteUserData, Knowledge files", () => {
  it("deletes the user's Knowledge files, their bytes, and cancels their queued jobs", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestSdk();
    const ownProject = uuidv7();
    const otherProject = uuidv7();
    await getTestDb()
      .insert(project)
      .values([
        { id: ownProject, userId: user.id, name: "Mine" },
        { id: otherProject, userId: other.id, name: "Theirs" },
      ]);
    const ownFile = uuidv7();
    const otherFile = uuidv7();
    await getTestDb()
      .insert(knowledgeFile)
      .values([
        {
          id: ownFile,
          userId: user.id,
          projectId: ownProject,
          name: "a.md",
          mediaType: "text/markdown",
          size: 1,
        },
        {
          id: otherFile,
          userId: other.id,
          projectId: otherProject,
          name: "b.md",
          mediaType: "text/markdown",
          size: 1,
        },
      ]);
    const bytes = new Uint8Array([1]);
    await deps.blobStore.put(knowledgeBlobKey(ownFile), bytes, { contentType: "text/markdown" });
    await deps.blobStore.put(knowledgeBlobKey(otherFile), bytes, { contentType: "text/markdown" });
    await deps.jobs.enqueue(
      "knowledge.process",
      { fileId: ownFile },
      { idempotencyKey: knowledgeJobKey(ownFile) },
    );

    await deleteUserData(deps, user.id);

    expect(
      await getTestDb().select().from(knowledgeFile).where(eq(knowledgeFile.id, ownFile)),
    ).toEqual([]);
    expect(await deps.blobStore.get(knowledgeBlobKey(ownFile))).toBeNull();
    expect(
      await getTestDb()
        .select({ status: job.status })
        .from(job)
        .where(eq(job.idempotencyKey, knowledgeJobKey(ownFile))),
    ).toEqual([{ status: "cancelled" }]);
    expect(
      await getTestDb().select().from(knowledgeFile).where(eq(knowledgeFile.id, otherFile)),
    ).toHaveLength(1);
    expect(await deps.blobStore.get(knowledgeBlobKey(otherFile))).not.toBeNull();
  });
});
