import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../core/server/assistant";
import { models } from "../../../plugins/models/server/plugin";
import { conversation } from "../../../core/server/db/schema";
import { storedParts } from "../../../core/shared/message-parts";
import { insertConversation, insertMessage } from "../../support/conversations";
import { testKeyEncryptionSecret } from "../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

const basePath = "/api/chat";

/** A `createBotSdk` signed in as `user`, with the owner's calls going through its handler. */
function chatFor(user: TestUser | null) {
  const chat = createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => (user ? { id: user.id } : null),
    keyEncryptionSecrets: [testKeyEncryptionSecret],
    basePath,
    plugins: [models(), assistant()],
  });
  const client = createBotSdkClient({
    baseUrl: `http://localhost${basePath}`,
    fetch: chat.handler,
  });
  return { chat, client };
}

describe("chat.getSharedConversation", () => {
  it("returns the snapshot of a shared Conversation, with no user", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Recursive CTEs" });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Explain CTEs",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "A CTE names a query.",
      active: true,
    });
    const { client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    const shared = await chatFor(null).chat.getSharedConversation(link.token);

    expect(shared).toMatchObject({ title: "Recursive CTEs" });
    expect(shared?.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
  });

  it("carries no context start, even when the reply has one (#122)", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello.",
      contextStartId: question.id,
      active: true,
    });
    const { client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    const shared = await chatFor(null).chat.getSharedConversation(link.token);

    expect(shared?.messages).toHaveLength(2);
    for (const shownMessage of shared?.messages ?? []) {
      expect(shownMessage).not.toHaveProperty("contextStartId");
    }
  });

  it("never carries the owner's Instructions", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Private" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello.",
      active: true,
    });
    const { client } = chatFor(owner);
    await client.rpc.settings.setInstructions({ instructions: "Always mention my cat." });
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    const shared = await chatFor(null).chat.getSharedConversation(link.token);

    expect(JSON.stringify(shared)).not.toContain("Always mention my cat.");
  });

  it("moves a re-shared link to the current Active Branch under the same token", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Branches" });
    const first = await insertMessage({ conversationId: conv.id, role: "user", text: "One" });
    await insertMessage({
      conversationId: conv.id,
      parentId: first.id,
      role: "assistant",
      text: "Reply one",
      active: true,
    });
    const { chat, client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });
    const before = await chat.getSharedConversation(link.token);
    expect(before?.messages).toHaveLength(2);

    const second = await insertMessage({
      conversationId: conv.id,
      parentId: first.id,
      role: "user",
      text: "Two",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: second.id,
      role: "assistant",
      text: "Reply two",
      active: true,
    });
    const reshared = await client.rpc.share.upsert({ conversationId: conv.id });
    const after = await chat.getSharedConversation(link.token);

    expect(reshared.token).toBe(link.token);
    expect(after?.messages.map(({ id }) => id)).toEqual([first.id, second.id, expect.any(String)]);
    expect(after?.messages.at(-1)?.parts).toEqual([{ type: "text", content: "Reply two" }]);
  });

  it("returns null for an unknown token", async () => {
    const { chat } = chatFor(null);

    expect(await chat.getSharedConversation("no-such-token")).toBeNull();
  });

  it("returns null once the owner removes the link", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Unshared" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });
    const { chat, client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    await client.rpc.share.delete({ conversationId: conv.id });

    expect(await chat.getSharedConversation(link.token)).toBeNull();
  });

  it("returns null once the Conversation is deleted", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Gone soon" });
    await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Bye",
      active: true,
    });
    const { chat, client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    await getTestDb().delete(conversation).where(eq(conversation.id, conv.id));

    expect(await chat.getSharedConversation(link.token)).toBeNull();
  });
});

describe("chat.getSharedConversation with tool calls", () => {
  it("shows an MCP tool call as used, with no arguments or result", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "MCP" });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Issues?",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-mcp",
          name: "linear_list_issues",
          source: "mcp",
          args: { team: "private" },
          result: { issues: ["private"] },
          state: "done",
        },
      ]),
      active: true,
    });
    const { client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    const shared = await chatFor(null).chat.getSharedConversation(link.token);
    const [, reply] = shared?.messages ?? [];

    expect(reply?.parts).toEqual([
      expect.objectContaining({
        type: "tool-call",
        id: "call-mcp",
        name: "linear_list_issues",
        arguments: "",
        metadata: expect.objectContaining({ source: "mcp", redacted: true }),
      }),
    ]);
    expect(JSON.stringify(shared)).not.toContain("private");
  });

  it("shows a host tool call as used, with no arguments or result, and a search in full", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Tools" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Time?" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-host",
          name: "server_time",
          source: "host",
          args: { zone: "private" },
          result: { now: "private" },
          state: "done",
        },
        {
          type: "web_search",
          toolCallId: "call-search",
          query: "tanstack",
          state: "done",
          results: [{ title: "TanStack", url: "https://tanstack.com", snippet: "Docs" }],
        },
      ]),
      active: true,
    });
    const { client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });

    const shared = await chatFor(null).chat.getSharedConversation(link.token);
    const [, reply] = shared?.messages ?? [];

    expect(reply?.parts).toEqual([
      expect.objectContaining({
        type: "tool-call",
        id: "call-host",
        name: "server_time",
        arguments: "",
        metadata: expect.objectContaining({ source: "host", redacted: true }),
      }),
      expect.objectContaining({
        type: "tool-call",
        id: "call-search",
        name: "web_search",
        output: { results: [{ title: "TanStack", url: "https://tanstack.com", snippet: "Docs" }] },
      }),
    ]);
    expect(JSON.stringify(shared)).not.toContain("private");
  });
});

describe("chat.isUserBlocked", () => {
  /** A Shared link of `owner`'s, made while the owner is still allowed. */
  async function sharedByOwner() {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Banned later" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });
    const { client } = chatFor(owner);
    const link = await client.rpc.share.upsert({ conversationId: conv.id });
    return { owner, link };
  }

  /** A `createBotSdk` whose Host has banned `blocked`, with `user` signed in. */
  function chatBanning(blocked: TestUser, user: TestUser | null) {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => (user ? { id: user.id } : null),
      keyEncryptionSecrets: [testKeyEncryptionSecret],
      basePath,
      isUserBlocked: (userId) => userId === blocked.id,
      plugins: [models(), assistant()],
    });
    const client = createBotSdkClient({
      baseUrl: `http://localhost${basePath}`,
      fetch: chat.handler,
    });
    return { chat, client };
  }

  it("hides a blocked owner's Shared link: it is not found", async () => {
    const { owner, link } = await sharedByOwner();

    const { chat, client } = chatBanning(owner, null);

    expect(await chat.getSharedConversation(link.token)).toBeNull();
    await expect(client.rpc.share.get({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to continue a blocked owner's Shared link", async () => {
    const { owner, link } = await sharedByOwner();
    const reader = await insertUser();

    const { client } = chatBanning(owner, reader);

    await expect(client.rpc.share.continue({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("leaves the Shared link of an owner who isn't blocked", async () => {
    const { link } = await sharedByOwner();
    const someoneElse = await insertUser();

    const { chat } = chatBanning(someoneElse, null);

    expect(await chat.getSharedConversation(link.token)).toMatchObject({ title: "Banned later" });
  });
});
