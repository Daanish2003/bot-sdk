import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { START } from "../../../../core/server/chat/run-streams";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, text } from "../../../support/fake-adapter";
import { chatRpc, createTestChat } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { EventType } from "@tanstack/ai";

async function conversationsOf(userId: string) {
  return getTestDb().select().from(conversation).where(eq(conversation.userId, userId));
}

describe("conversation.deleteAll", () => {
  it("deletes every Conversation the caller owns, in and out of Projects, with what hangs off them", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const deps = createTestDeps();
    const client = chatRpc({ user: owner, deps });
    const otherClient = chatRpc({ user: other, deps });

    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Work" });
    const inProject = await insertConversation(owner, { title: "In Work", projectId });
    const loose = await insertConversation(owner, { title: "Loose" });
    // Sharing needs an answer on the Active Branch.
    for (const conv of [loose, inProject]) {
      const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
      await insertMessage({
        conversationId: conv.id,
        parentId: question.id,
        role: "assistant",
        text: "Hello!",
        active: true,
      });
    }
    const link = await client.share.upsert({ conversationId: loose.id });
    const inProjectLink = await client.share.upsert({ conversationId: inProject.id });
    const theirs = await insertConversation(other, { title: "Theirs" });
    const theirsQuestion = await insertMessage({
      conversationId: theirs.id,
      role: "user",
      text: "Hi",
    });
    await insertMessage({
      conversationId: theirs.id,
      parentId: theirsQuestion.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });
    const theirsLink = await otherClient.share.upsert({ conversationId: theirs.id });

    await client.conversation.deleteAll();

    expect(await conversationsOf(owner.id)).toEqual([]);
    const projects = await getTestDb().select().from(project).where(eq(project.userId, owner.id));
    expect(projects.map((row) => row.id)).toEqual([projectId]);
    for (const shared of [link, inProjectLink]) {
      await expect(
        chatRpc({ user: null, deps }).share.get({ token: shared.token }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await conversationsOf(other.id)).toHaveLength(1);
    expect(await otherClient.share.get({ token: theirsLink.token })).toMatchObject({
      title: "Theirs",
    });
  });

  it("succeeds with no Conversations", async () => {
    const owner = await insertUser();
    const client = chatRpc({ user: owner });

    await expect(client.conversation.deleteAll()).resolves.toBeUndefined();
    await expect(client.conversation.deleteAll()).resolves.toBeUndefined();
    expect(await conversationsOf(owner.id)).toEqual([]);
  });

  it("rejects signed-out callers and deletes nothing", async () => {
    const owner = await insertUser();
    await insertConversation(owner, { title: "Mine" });

    await expect(chatRpc({ user: null }).conversation.deleteAll()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await conversationsOf(owner.id)).toHaveLength(1);
  });

  describe("a live Run", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is stopped before its Conversation goes, and writes nothing after", async () => {
      const owner = await insertUser();
      const conv = await insertConversation(owner, { title: "Live" });
      const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
      await saveCredentials(createTestDeps(), owner.id, {
        service: "anthropic",
        fields: { apiKey: "sk-ant-test-key" },
        hint: "…-key",
        verified: true,
      });
      // Held until the test releases it, so the Run is still live when the Conversations go.
      const fake = createFakeAdapter({ rounds: [text("Hel", "lo")], manual: true });
      const deps = createTestDeps({ adapterFor: () => fake.adapter });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createTestChat({ user: owner, deps });
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

      await client.rpc.conversation.deleteAll();

      // The log ends with a terminal chunk, so a reader does not reconnect and start the Run again.
      const chunks = [];
      for await (const entry of deps.runStreams.read(reply.id, START)) chunks.push(entry.chunk);
      expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(await getTestDb().select().from(message).where(eq(message.id, reply.id))).toEqual([]);
      expect(await conversationsOf(owner.id)).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});
