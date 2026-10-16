import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { sweepExpiredTemporaryConversations } from "../../../core/server/chat/temporary";
import { saveCredentials } from "../../../core/server/credentials/store";
import {
  attachment,
  messageAttachment,
  conversation,
  message,
  sharedLink,
} from "../../../core/server/db/schema";
import { createLifecycle } from "../../../core/server/lifecycle";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage, testModel } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
import { createFakeAdapter, round, text } from "../../support/fake-adapter";
import { chatRpc, sendAs } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";
import type { ChatCommand } from "../../../core/shared/chat/command";

const testKey = "test-key-encryption-secret-not-for-production";
const day = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(Date.now() - days * day);

async function conversationExists(id: string) {
  const rows = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
  return rows.length > 0;
}

async function messageCount(conversationId: string) {
  const rows = await getTestDb()
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId));
  return rows.length;
}

async function attachmentExists(id: string) {
  const rows = await getTestDb().select().from(attachment).where(eq(attachment.id, id));
  return rows.length > 0;
}

function chatRequest(command: Partial<ChatCommand> & Record<string, unknown>) {
  return new Request("http://localhost/api/chat/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], forwardedProps: command }),
  });
}

describe("a Temporary Conversation past its 30 days", () => {
  it("answers not found on every read and write", async () => {
    const user = await insertUser();
    const client = chatRpc({ user });
    const expired = await insertConversation(user, {
      temporary: true,
      lastMessageAt: daysAgo(31),
    });

    await expect(client.conversation.get({ id: expired.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client.conversation.rename({ id: expired.id, title: "Renamed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.conversation.delete({ id: expired.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("still answers on its 29th day", async () => {
    const user = await insertUser();
    const live = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(29) });

    await expect(chatRpc({ user }).conversation.get({ id: live.id })).resolves.toMatchObject({
      id: live.id,
      temporary: true,
    });
  });

  it("refuses a send to it and writes no Message", async () => {
    const user = await insertUser();
    const expired = await insertConversation(user, {
      temporary: true,
      lastMessageAt: daysAgo(31),
    });
    const deps = await sendDeps(user);

    const response = await sendAs(
      chatRequest({
        conversationId: expired.id,
        parentId: null,
        text: "Still there?",
        attachmentIds: [],
        model: testModel,
        webSearch: false,
      }),
      user,
      deps,
    );

    expect(response.status).toBe(404);
    expect(await messageCount(expired.id)).toBe(0);
  });

  it("restarts its 30 days with each new Message", async () => {
    const user = await insertUser();
    const deps = await sendDeps(user);
    const live = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(29) });

    await (
      await sendAs(
        chatRequest({
          conversationId: live.id,
          parentId: null,
          text: "Hello again",
          attachmentIds: [],
          model: testModel,
          webSearch: false,
        }),
        user,
        deps,
      )
    ).text();

    // Had the send not bumped `lastMessageAt`, the Conversation would be 29 days old, and a sweep
    // two days on would delete it.
    await sweepExpiredTemporaryConversations(deps, new Date(Date.now() + 2 * day));
    expect(await conversationExists(live.id)).toBe(true);
  });
});

/** Test deps whose Model answers a short reply, with Anthropic credentials saved for `user`. */
async function sendDeps(user: TestUser) {
  const fake = createFakeAdapter({ rounds: [round(text("Hello"))] });
  const deps = createTestDeps({ adapterFor: () => fake.adapter });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  return deps;
}

describe("sweepExpiredTemporaryConversations", () => {
  it("deletes an expired Temporary Conversation with its Messages and Attachments, and leaves a younger one", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    const expired = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });
    const expiredMessage = await insertMessage({
      conversationId: expired.id,
      role: "user",
      text: "Old question",
    });
    const file = await insertAttachment(user, { filename: "old.txt" });
    await linkTestAttachments(expiredMessage.id, [file.id]);
    const younger = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(29) });
    await insertMessage({ conversationId: younger.id, role: "user", text: "Recent question" });

    await sweepExpiredTemporaryConversations(deps);

    expect(await conversationExists(expired.id)).toBe(false);
    expect(await messageCount(expired.id)).toBe(0);
    expect(await attachmentExists(file.id)).toBe(false);
    expect(await conversationExists(younger.id)).toBe(true);
    expect(await messageCount(younger.id)).toBe(1);
  });

  it("takes its now as an argument", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    const younger = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(29) });

    await sweepExpiredTemporaryConversations(deps, new Date());
    expect(await conversationExists(younger.id)).toBe(true);

    await sweepExpiredTemporaryConversations(deps, new Date(Date.now() + 2 * day));
    expect(await conversationExists(younger.id)).toBe(false);
  });

  it("keeps an Attachment that a Message in a live Conversation still uses", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    const expired = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });
    const expiredMessage = await insertMessage({
      conversationId: expired.id,
      role: "user",
      text: "A",
    });
    const live = await insertConversation(user, { lastMessageAt: new Date() });
    const liveMessage = await insertMessage({ conversationId: live.id, role: "user", text: "B" });
    const file = await insertAttachment(user);
    await linkTestAttachments(expiredMessage.id, [file.id]);
    await linkTestAttachments(liveMessage.id, [file.id]);

    await sweepExpiredTemporaryConversations(deps);

    expect(await conversationExists(expired.id)).toBe(false);
    expect(await attachmentExists(file.id)).toBe(true);
    const links = await getTestDb()
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.messageId, liveMessage.id));
    expect(links).toHaveLength(1);
  });

  it("never deletes an ordinary Conversation, however old", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    const ordinary = await insertConversation(user, { lastMessageAt: daysAgo(400) });

    await sweepExpiredTemporaryConversations(deps);

    expect(await conversationExists(ordinary.id)).toBe(true);
  });
});

describe("the reaper's sweep", () => {
  it("runs with start(), then not again until an hour has passed", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    const lifecycle = createLifecycle(deps);
    const first = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });

    await lifecycle.start();
    expect(await conversationExists(first.id)).toBe(false);

    const second = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });
    await lifecycle.start();
    expect(await conversationExists(second.id)).toBe(true);
    await lifecycle.stop();
  });
});

describe("an expired Temporary Conversation's other reads", () => {
  it("leaves it out of the export, with its Messages", async () => {
    const user = await insertUser();
    const expired = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });
    await insertMessage({ conversationId: expired.id, role: "user", text: "Gone" });
    const ordinary = await insertConversation(user, { title: "Ordinary" });

    const exported = await createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
    }).exportUser(user.id);

    expect(exported.conversations.map((row) => row.id)).toEqual([ordinary.id]);
    expect(exported.conversations[0]!.messages).toEqual([]);
  });

  it("answers a Shared link's public read not found", async () => {
    const user = await insertUser();
    const expired = await insertConversation(user, { temporary: true, lastMessageAt: daysAgo(31) });
    const leaf = await insertMessage({
      conversationId: expired.id,
      role: "user",
      text: "Shared",
      active: true,
    });
    await getTestDb().insert(sharedLink).values({
      token: "expired-token-0000000000",
      conversationId: expired.id,
      leafMessageId: leaf.id,
      title: "Shared",
    });

    await expect(
      chatRpc({ user: null }).share.get({ token: "expired-token-0000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
