import { randomUUID } from "node:crypto";

import { EventType } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChat } from "../../../core/server/create-chat";
import { deleteUserData } from "../../../core/server/delete-user";
import { saveCredentials } from "../../../core/server/credentials/store";
import { START } from "../../../core/server/chat/run-streams";
import {
  attachment,
  attachmentBlob,
  messageAttachment,
} from "../../../core/server/db/schema/attachment";
import { conversation, message, project } from "../../../core/server/db/schema/chat";
import { userCredentials } from "../../../core/server/db/schema/credentials";
import { sharedLink } from "../../../core/server/db/schema/share";
import { userSettings } from "../../../core/server/db/schema/settings";
import { usage } from "../../../core/server/db/schema/usage";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
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
  const deps = createTestDeps();
  const link = await createTestChat({ user, deps }).rpc.share.upsert({ conversationId: conv.id });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await getTestDb()
    .insert(userSettings)
    .values({ userId: user.id, titleModel: "anthropic:x", instructions: "Be terse." });
  await getTestDb().insert(project).values({ id: uuidv7(), userId: user.id, name: "Work" });
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
  return { conv, question, reply, file, link, deps };
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
    attachmentBlobs: await count(
      db.select().from(attachmentBlob).where(inArray(attachmentBlob.attachmentId, ownAttachments)),
    ),
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
    usage: await count(db.select().from(usage).where(eq(usage.userId, userId))),
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
  usage: 0,
};

describe("deleteUserData", () => {
  it("removes every row the user owns and leaves other users' rows alone", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner);
    const kept = await seedOwner(other);
    const before = await ownedRows(other.id);

    await deleteUserData(createTestDeps(), owner.id);

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
    const deps = createTestDeps();

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
      await expect(deleteUserData(createTestDeps(), owner.id)).rejects.toMatchObject({
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
      await saveCredentials(createTestDeps(), owner.id, {
        service: "anthropic",
        fields: { apiKey: "sk-ant-test-key" },
        hint: "…-key",
        verified: true,
      });
      // Held until the test releases it, so the Run is still live when the user is deleted.
      const fake = createFakeAdapter({ rounds: [text("Hel", "lo")], manual: true });
      const deps = createTestDeps({ adapterFor: () => fake.adapter });
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

describe("createChat().deleteUser", () => {
  it("removes the user's rows through the Host's entry point", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner);
    await seedOwner(other);
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
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
