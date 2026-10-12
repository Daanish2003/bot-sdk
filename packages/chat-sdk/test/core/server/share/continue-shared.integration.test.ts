import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversation, message } from "../../../../core/server/db/schema/chat";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { createTestDeps } from "../../../support/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { chatRpc, createTestChat } from "../../../support/sdk";

/** An owner with a two-reply Branch that has a thinking part, shared, and the Active Branch leaf. */
async function sharedConversation() {
  const owner = await insertUser();
  const conv = await insertConversation(owner, {
    title: "Recursive CTEs",
    model: "openai:gpt-5.6",
    projectId: null,
  });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Explain" });
  const reply = await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "A CTE names a query.",
    parts: {
      schemaVersion: 1,
      parts: [
        { type: "thinking", text: "Private reasoning" },
        { type: "text", text: "A CTE names a query." },
      ],
    },
    model: "openai:gpt-5.6",
    active: true,
  });
  const ownerRpc = chatRpc({ user: owner });
  const link = await ownerRpc.share.upsert({ conversationId: conv.id });
  return { owner, conv, question, reply, link };
}

async function messagesOf(conversationId: string) {
  return getTestDb().select().from(message).where(eq(message.conversationId, conversationId));
}

describe("share.continue", () => {
  it("copies the shared Branch into a new Conversation owned by the caller", async () => {
    const { conv, question, reply, link } = await sharedConversation();
    const viewer = await insertUser();
    await saveCredentials(createTestDeps(), viewer.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });

    const { id } = await chatRpc({ user: viewer }).share.continue({ token: link.token });

    const [copy] = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
    expect(copy).toMatchObject({
      userId: viewer.id,
      title: "Recursive CTEs",
      model: "openai:gpt-5.6",
      projectId: null,
      pinnedAt: null,
    });
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(2);
    const copiedQuestion = rows.find((row) => row.role === "user");
    const copiedReply = rows.find((row) => row.role === "assistant");
    expect(copiedQuestion?.id).not.toBe(question.id);
    expect(copiedReply?.id).not.toBe(reply.id);
    expect(copiedReply?.parentId).toBe(copiedQuestion?.id);
    expect(copiedQuestion?.parentId).toBeNull();
    expect(copy?.activeLeafId).toBe(copiedReply?.id);
    expect(copiedReply?.parts).toEqual({
      schemaVersion: 2,
      parts: [{ type: "text", text: "A CTE names a query." }],
    });
    expect(copiedReply?.searchText).toBe("A CTE names a query.");
    expect(copiedQuestion?.searchText).toBe("Explain");
    expect(rows.every((row) => row.conversationId === id)).toBe(true);
    expect(conv.id).not.toBe(id);
  });

  it("leaves the owner's Conversation, Messages and Shared link untouched", async () => {
    const { owner, conv, link } = await sharedConversation();
    const viewer = await insertUser();
    const before = await messagesOf(conv.id);
    await saveCredentials(createTestDeps(), viewer.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const { id } = await chatRpc({ user: viewer }).share.continue({ token: link.token });
    await insertMessage({
      conversationId: id,
      parentId: (await messagesOf(id)).find((row) => row.role === "assistant")?.id,
      role: "user",
      text: "A follow-up in the copy",
    });

    const [original] = await getTestDb()
      .select()
      .from(conversation)
      .where(eq(conversation.id, conv.id));
    expect(original?.userId).toBe(owner.id);
    expect(await messagesOf(conv.id)).toEqual(before);
    await expect(
      chatRpc({ user: owner }).share.forConversation({ conversationId: conv.id }),
    ).resolves.toMatchObject({ link: { token: link.token }, movedOn: false });
  });

  it("answers NOT_FOUND for an unknown or revoked token", async () => {
    const { owner, conv, link } = await sharedConversation();
    const viewer = chatRpc({ user: await insertUser() });

    await expect(viewer.share.continue({ token: "no-such-token" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await chatRpc({ user: owner }).share.delete({ conversationId: conv.id });
    await expect(viewer.share.continue({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses signed-out viewers", async () => {
    const { link } = await sharedConversation();

    await expect(chatRpc().share.continue({ token: link.token })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("falls back to the viewer's default Model when the shared one isn't usable", async () => {
    const { link } = await sharedConversation();
    const viewer = await insertUser();
    const deps = createTestDeps({ adapterFor: () => createFakeAdapter({ rounds: [] }).adapter });
    await saveCredentials(deps, viewer.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });

    const { id } = await chatRpc({ user: viewer, deps }).share.continue({ token: link.token });

    const [copy] = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
    expect(copy?.model).toMatch(/^anthropic:/);
  });

  it("runs a reply in the copy with the copied Messages as its history", async () => {
    const { link } = await sharedConversation();
    const viewer = await insertUser();
    const fake = createFakeAdapter({ rounds: [round(text("Sure"))] });
    const deps = createTestDeps({ adapterFor: () => fake.adapter });
    await saveCredentials(deps, viewer.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const { id } = await chatRpc({ user: viewer, deps }).share.continue({ token: link.token });
    const leaf = (await messagesOf(id)).find((row) => row.role === "assistant");
    const chat = createTestChat({ user: viewer, deps });

    const response = await chat.fetch(
      new Request(chat.chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: id,
            parentId: leaf?.id,
            text: "Follow up",
            attachmentIds: [],
            model: "openai:gpt-5.6",
            webSearch: false,
          },
        }),
      }),
    );
    await response.text();

    expect(fake.calls[0]?.messages).toEqual([
      { role: "user", content: "Explain" },
      { role: "assistant", content: "A CTE names a query." },
      { role: "user", content: "Follow up" },
    ]);
  });
});
