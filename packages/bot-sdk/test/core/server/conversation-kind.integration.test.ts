import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { AssistantExport } from "../../../plugins/assistant/server/export-user";
import { createBotSdk } from "../../../core/server/create-chat";
import { conversation } from "../../../core/server/db/schema";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { runner } from "../../../plugins/runner/server/plugin";
import { searchPastChats } from "../../../plugins/assistant/server/search/past-chats";
import { models } from "../../../plugins/models/server/plugin";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

/** A user with one assistant Conversation and one of another plugin's, both holding "otters". */
async function userWithABotConversation() {
  const user = await insertUser();
  const own = await insertConversation(user, { title: "Mine" });
  await insertMessage({ conversationId: own.id, role: "user", text: "otters", active: true });
  const bot = await insertConversation(user, { kind: "bot", model: null, title: "Ada" });
  await insertMessage({ conversationId: bot.id, role: "user", text: "otters", active: true });
  return { user, own, bot, client: chatRpc({ user }) };
}

async function kindOf(id: string) {
  const [row] = await getTestDb()
    .select({ kind: conversation.kind })
    .from(conversation)
    .where(eq(conversation.id, id));
  return row?.kind;
}

describe("the assistant's own Conversations", () => {
  it("creates every Conversation as an assistant one", async () => {
    const user = await insertUser();
    await saveCredentials(createTestSdk(), user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const client = chatRpc({ user });

    const { id } = await client.conversation.create({ model: "openai:gpt-5.6" });
    await insertMessage({ conversationId: id, role: "user", text: "Hi", active: true });
    const link = await client.share.upsert({ conversationId: id });
    const copy = await client.share.continue({ token: link.token });

    expect(await kindOf(id)).toBe("assistant");
    expect(await kindOf(copy.id)).toBe("assistant");
  });

  it("refuses another plugin's Conversation, as if it didn't exist", async () => {
    const { bot, client } = await userWithABotConversation();

    for (const call of [
      () => client.conversation.get({ id: bot.id }),
      () => client.conversation.rename({ id: bot.id, title: "Renamed" }),
      () => client.conversation.pin({ id: bot.id }),
      () => client.conversation.archive({ id: bot.id }),
      () => client.conversation.delete({ id: bot.id }),
      () => client.share.upsert({ conversationId: bot.id }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await kindOf(bot.id)).toBe("bot");
  });

  it("leaves another plugin's Conversations out of the lists", async () => {
    const user = await insertUser();
    const own = await insertConversation(user);
    await insertConversation(user, { kind: "bot", model: null });
    await insertConversation(user, { kind: "bot", model: null, pinnedAt: new Date() });
    await insertConversation(user, { kind: "bot", model: null, archivedAt: new Date() });
    const client = chatRpc({ user });

    expect((await client.conversation.list({})).items.map((row) => row.id)).toEqual([own.id]);
    expect(await client.conversation.pinned()).toEqual([]);
    expect((await client.conversation.archived({})).items).toEqual([]);
  });

  it("leaves another plugin's Conversations alone on archive all and delete all", async () => {
    const { bot, client } = await userWithABotConversation();

    await client.conversation.archiveAll();
    await client.conversation.deleteAll();

    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, bot.id));
    expect(row).toMatchObject({ kind: "bot", archivedAt: null });
  });

  it("leaves another plugin's Conversations out of search", async () => {
    const { own, client } = await userWithABotConversation();

    const { hits } = await client.search.query({ q: "otters" });

    expect(hits.map((hit) => hit.conversationId)).toEqual([own.id]);
  });

  it("leaves another plugin's Conversations out of the export", async () => {
    const { user, own } = await userWithABotConversation();
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      plugins: [models(), runner(), assistant()],
    });

    const exported = (await sdk.exportUser(user.id)).assistant as AssistantExport;

    expect(exported.conversations.map((row) => row.id)).toEqual([own.id]);
  });

  it("leaves another plugin's Conversations out of Memory's past chats", async () => {
    const { user, own } = await userWithABotConversation();
    const deps = createTestSdk();
    const current = await insertConversation(user);

    const hits = await searchPastChats(
      deps,
      { userId: user.id, conversationId: current.id, projectId: null },
      "otters",
    );

    expect(hits.map((hit) => hit.conversationId)).toEqual([own.id]);
  });
});
