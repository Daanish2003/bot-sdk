import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { getTestDb } from "../../../support/test-database";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { insertConversation, insertMessage, testModel } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { liveModelsFetch } from "../../../support/live-models";
import { insertUser } from "../../../support/users";
import { chatRpc, createTestChat, sendAs } from "../../../support/sdk";

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user }) };
}

/** The first page's rows, for the tests that don't follow the cursor. */
async function listItems(client: ReturnType<typeof chatRpc>) {
  return (await client.conversation.list({})).items;
}

describe("conversation.create", () => {
  it("creates an empty Conversation with the chosen Model", async () => {
    const { client } = await signedIn();

    const { id } = await client.conversation.create({ model: "openai:gpt-5.6" });

    await expect(client.conversation.get({ id })).resolves.toMatchObject({
      id,
      title: null,
      model: "openai:gpt-5.6",
      messages: [],
    });
  });

  it("refuses a Model that isn't available", async () => {
    const { client } = await signedIn();

    await expect(client.conversation.create({ model: "openai:gpt-2" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("conversation.get", () => {
  it("returns the Active Branch path, oldest first, leaving out other Branches", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const older = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "An older reply",
    });
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });

    const result = await client.conversation.get({ id: conv.id });

    expect(result.messages).toEqual([
      {
        id: question.id,
        parentId: null,
        role: "user",
        parts: [{ type: "text", content: "Hi" }],
        attachments: [],
        model: null,
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt: question.createdAt,
        siblings: { index: 0, count: 1, previousId: null, nextId: null },
      },
      {
        id: reply.id,
        parentId: question.id,
        role: "assistant",
        parts: [{ type: "text", content: "Hello!" }],
        attachments: [],
        model: "anthropic:claude-sonnet-5-5",
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt: reply.createdAt,
        siblings: { index: 1, count: 2, previousId: older.id, nextId: null },
      },
    ]);
  });

  it("hides other users' Conversations", async () => {
    const owner = await signedIn();
    const conv = await insertConversation(owner.user);
    const other = await signedIn();

    await expect(other.client.conversation.get({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("answers NOT_FOUND for an id that isn't a Conversation", async () => {
    const { client } = await signedIn();

    await expect(
      client.conversation.get({ id: "0190a000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects signed-out callers", async () => {
    const client = chatRpc();

    await expect(client.conversation.create({ model: "openai:gpt-5.6" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      client.conversation.get({ id: "0190a000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("conversation.list", () => {
  it("lists only the caller's Conversations, newest Message first", async () => {
    const { user, client } = await signedIn();
    const older = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });
    const newer = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-05T10:00:00Z"),
    });
    const other = await signedIn();
    await insertConversation(other.user);

    const list = await listItems(client);

    expect(list.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  it("previews the Active Branch's last Message on one line, with its Model and error flag", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { title: "Recursion", model: "openai:gpt-5.6" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "A reply on another Branch",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Partial\n\nanswer",
      status: "error",
      active: true,
    });

    const [row] = await listItems(client);

    expect(row).toEqual({
      id: conv.id,
      title: "Recursion",
      model: "openai:gpt-5.6",
      lastMessageAt: conv.lastMessageAt,
      preview: "Partial answer",
      hasError: true,
      shared: false,
      pinnedAt: null,
      projectId: null,
    });
  });

  it("flags a Conversation that has a Shared link", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });
    await client.share.upsert({ conversationId: conv.id });

    await expect(listItems(client)).resolves.toMatchObject([{ shared: true }]);
  });

  it("previews the question while its reply hasn't written any text yet", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "What is a CTE?",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      status: "streaming",
      active: true,
    });

    const [row] = await listItems(client);

    expect(row).toMatchObject({ preview: "What is a CTE?", hasError: false });
  });

  it("shows an empty Conversation with no preview and no error", async () => {
    const { user, client } = await signedIn();
    await insertConversation(user);

    const [row] = await listItems(client);

    expect(row).toMatchObject({ title: null, preview: "", hasError: false });
  });

  it("rejects signed-out callers", async () => {
    await expect(listItems(chatRpc())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("conversation.list paging", () => {
  /** Inserts `count` Conversations, two per minute, so ties on `lastMessageAt` are exercised. */
  async function seedConversations(userId: string, count: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: uuidv7(),
      userId,
      model: testModel,
      lastMessageAt: new Date(Date.UTC(2026, 9, 1, 9, Math.floor(i / 2))),
    }));
    await getTestDb().insert(conversation).values(rows);
    return rows;
  }

  /** Newest first, ties broken by the larger id first: the order the list must follow. */
  const newestFirst = (rows: { id: string; lastMessageAt: Date }[]) =>
    [...rows]
      .sort(
        (a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime() || (a.id < b.id ? 1 : -1),
      )
      .map((row) => row.id);

  it("pages 120 Conversations 50, 50 and 20, with no gaps or repeats", async () => {
    const { user, client } = await signedIn();
    const rows = await seedConversations(user.id, 120);

    const first = await client.conversation.list({});
    const second = await client.conversation.list({ cursor: first.nextCursor ?? undefined });
    const third = await client.conversation.list({ cursor: second.nextCursor ?? undefined });

    expect([first.items, second.items, third.items].map((page) => page.length)).toEqual([
      50, 50, 20,
    ]);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
    expect(ids).toEqual(newestFirst(rows));
  });

  it("keeps the next page stable when a Conversation is added between page reads", async () => {
    const { user, client } = await signedIn();
    const rows = await seedConversations(user.id, 120);
    const first = await client.conversation.list({});
    await insertConversation(user, { lastMessageAt: new Date("2026-10-10T00:00:00Z") });

    const second = await client.conversation.list({ cursor: first.nextCursor ?? undefined });

    expect(second.items.map((row) => row.id)).toEqual(newestFirst(rows).slice(50, 100));
  });

  it("answers BAD_REQUEST for a cursor the server didn't write", async () => {
    const { client } = await signedIn();
    const tampered = Buffer.from(
      JSON.stringify({ lastMessageAt: "2026-10-01 09:00:00", id: "not-a-uuid" }),
    ).toString("base64url");

    await expect(client.conversation.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.conversation.list({ cursor: tampered })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("leaves out Conversations in a Project and pinned ones, which show only under Pinned", async () => {
    const { user, client } = await signedIn();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Work" });
    await insertConversation(user, { title: "In a Project", projectId });
    await insertConversation(user, { title: "Pinned", pinnedAt: new Date("2026-10-02T08:00:00Z") });
    const plain = await insertConversation(user, { title: "Plain" });

    const items = await listItems(client);

    expect(items.map((row) => row.id)).toEqual([plain.id]);
  });

  it("doesn't move a Conversation for a rename or a Branch switch, but moves it for a new Message", async () => {
    const { user, client } = await signedIn();
    const older = await insertConversation(user, {
      title: "Older",
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });
    const newer = await insertConversation(user, {
      title: "Newer",
      lastMessageAt: new Date("2026-10-05T10:00:00Z"),
    });
    const question = await insertMessage({ conversationId: older.id, role: "user", text: "Hi" });
    const reply = await insertMessage({
      conversationId: older.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello",
      active: true,
    });
    const another = await insertMessage({
      conversationId: older.id,
      parentId: question.id,
      role: "assistant",
      text: "Another",
    });

    await client.conversation.rename({ id: older.id, title: "Renamed" });
    await client.conversation.switchBranch({ messageId: another.id });
    expect((await listItems(client)).map((row) => row.id)).toEqual([newer.id, older.id]);

    const fake = createFakeAdapter({ rounds: [round(text("Sure"))] });
    const deps = createTestDeps({ adapterFor: () => fake.adapter });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    const chat = createTestChat({ user, deps });
    await chat.fetch(
      new Request(chat.chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: older.id,
            parentId: reply.id,
            text: "Follow up",
            attachmentIds: [],
            model: testModel,
            webSearch: false,
          },
        }),
      }),
    );

    expect((await listItems(client)).map((row) => row.id)).toEqual([older.id, newer.id]);
  });
});

describe("conversation.rename", () => {
  it("renames the Conversation without moving it in the list", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });

    await client.conversation.rename({ id: conv.id, title: "  Recursive CTEs  " });

    await expect(listItems(client)).resolves.toMatchObject([
      { id: conv.id, title: "Recursive CTEs", lastMessageAt: conv.lastMessageAt },
    ]);
  });

  it("refuses a blank title", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);

    await expect(client.conversation.rename({ id: conv.id, title: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("can't rename another user's Conversation", async () => {
    const owner = await signedIn();
    const conv = await insertConversation(owner.user, { title: "Mine" });
    const other = await signedIn();

    await expect(
      other.client.conversation.rename({ id: conv.id, title: "Yours now" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      title: "Mine",
    });
  });
});

describe("conversation.delete", () => {
  it("deletes the Conversation and its Messages for good", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });

    await client.conversation.delete({ id: conv.id });

    await expect(listItems(client)).resolves.toEqual([]);
    await expect(client.conversation.get({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getTestDb().select().from(message).where(eq(message.conversationId, conv.id)),
    ).resolves.toEqual([]);
  });

  it("can't delete another user's Conversation", async () => {
    const owner = await signedIn();
    const conv = await insertConversation(owner.user);
    const other = await signedIn();

    await expect(other.client.conversation.delete({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      id: conv.id,
    });
  });

  it("rejects signed-out callers for rename and delete", async () => {
    const client = chatRpc();
    const id = "0190a000-0000-7000-8000-000000000000";

    await expect(client.conversation.rename({ id, title: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.conversation.delete({ id })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("conversation.setModel", () => {
  async function withCredentials() {
    const { user, client } = await signedIn();
    for (const service of ["anthropic", "openai"] as const) {
      await saveCredentials(createTestDeps(), user.id, {
        service,
        fields: { apiKey: `${service}-test-key` },
        hint: "…-key",
        verified: true,
      });
    }
    return { user, client };
  }

  it("selects another Model without moving the Conversation in the list", async () => {
    const { user, client } = await withCredentials();
    const conv = await insertConversation(user, { model: "anthropic:claude-sonnet-5-5" });

    await client.conversation.setModel({ id: conv.id, model: "openai:gpt-6-luna" });

    await expect(client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      model: "openai:gpt-6-luna",
    });
    const [listed] = await listItems(client);
    expect(listed).toMatchObject({ model: "openai:gpt-6-luna", lastMessageAt: conv.lastMessageAt });
  });

  it("refuses a Model that isn't available", async () => {
    const { user, client } = await withCredentials();
    const conv = await insertConversation(user);

    await expect(
      client.conversation.setModel({ id: conv.id, model: "openai:gpt-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a Model whose Provider the user has no credentials for", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);

    await expect(
      client.conversation.setModel({ id: conv.id, model: "openai:gpt-5.6" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      model: conv.model,
    });
  });

  it("can't change another user's Conversation, whatever the Model", async () => {
    const { client } = await signedIn();
    const conv = await insertConversation(await insertUser());

    await expect(
      client.conversation.setModel({ id: conv.id, model: "openai:gpt-5.6" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects signed-out callers", async () => {
    const conv = await insertConversation(await insertUser());

    await expect(
      chatRpc().conversation.setModel({ id: conv.id, model: "openai:gpt-5.6" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("switches Model mid-Conversation: the next reply is written by the newly selected Model", async () => {
    const user = await insertUser();
    const fake = createFakeAdapter({
      rounds: [round(text("From Claude")), round(text("From GPT"))],
    });
    const adapterModels: string[] = [];
    const deps = createTestDeps({
      adapterFor: (model) => {
        adapterModels.push(model);
        return fake.adapter;
      },
    });
    for (const service of ["anthropic", "openai"] as const) {
      await saveCredentials(deps, user.id, {
        service,
        fields: { apiKey: `${service}-test-key` },
        hint: "…-key",
        verified: true,
      });
    }
    const client = chatRpc({ user, deps });
    // What the client does: send with the Conversation's selected Model, continuing the Active Branch.
    const sendNext = async (text: string) => {
      const current = await client.conversation.get({ id });
      const response = await sendAs(
        new Request("http://localhost/api/chat/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [],
            forwardedProps: {
              conversationId: id,
              parentId: current.messages.at(-1)?.id ?? null,
              text,
              attachmentIds: [],
              model: current.model,
              webSearch: false,
            },
          }),
        }),
        user,
        deps,
      );
      await response.text();
    };
    const { id } = await client.conversation.create({ model: "anthropic:claude-sonnet-5-5" });
    // Titled, so no automatic title call takes the scripted adapter.
    await client.conversation.rename({ id, title: "Switching Models" });

    await sendNext("First question");
    await client.conversation.setModel({ id, model: "openai:gpt-5.6" });
    await sendNext("Second question");

    const result = await client.conversation.get({ id });
    expect(adapterModels).toEqual(["anthropic:claude-sonnet-5-5", "openai:gpt-5.6"]);
    expect(result.model).toBe("openai:gpt-5.6");
    expect(result.messages.map((m) => [m.role, m.model, m.parts])).toEqual([
      ["user", null, [{ type: "text", content: "First question" }]],
      ["assistant", "anthropic:claude-sonnet-5-5", [{ type: "text", content: "From Claude" }]],
      ["user", null, [{ type: "text", content: "Second question" }]],
      ["assistant", "openai:gpt-5.6", [{ type: "text", content: "From GPT" }]],
    ]);
  });
});

describe("conversation.switchBranch", () => {
  /** `minute` minutes into a fixed morning, so Branch order doesn't depend on any clock. */
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute));

  /**
   * q1 ─ a1 ─ q2 ─ a2          (q2b edits q2; a2b is the newest leaf under a1)
   *    │     └ q2b ─ a2b
   *    └ a1b                    (regenerated a1, active)
   */
  async function branchyConversation() {
    const { user, client } = await signedIn();
    const lastMessageAt = at(30);
    const conv = await insertConversation(user, { lastMessageAt });
    const add = (minute: number, role: "user" | "assistant", parentId: string | null) =>
      insertMessage({
        conversationId: conv.id,
        parentId,
        role,
        text: `minute ${minute}`,
        createdAt: at(minute),
      });
    const q1 = await add(0, "user", null);
    const a1 = await add(1, "assistant", q1.id);
    const q2 = await add(2, "user", a1.id);
    const a2 = await add(3, "assistant", q2.id);
    const q2b = await add(4, "user", a1.id);
    const a2b = await add(5, "assistant", q2b.id);
    const a1b = await add(6, "assistant", q1.id);
    await getTestDb()
      .update(conversation)
      .set({ activeLeafId: a1b.id })
      .where(eq(conversation.id, conv.id));
    return { user, client, conv, lastMessageAt, q1, a1, q2, a2, q2b, a2b, a1b };
  }

  it("makes the newest leaf under the sibling active, without bumping lastMessageAt", async () => {
    const { client, conv, lastMessageAt, q1, a1, q2b, a2b } = await branchyConversation();

    await client.conversation.switchBranch({ messageId: a1.id });

    const result = await client.conversation.get({ id: conv.id });
    expect(result.messages.map((m) => m.id)).toEqual([q1.id, a1.id, q2b.id, a2b.id]);
    expect(result.messages.map((m) => m.siblings)).toEqual([
      { index: 0, count: 1, previousId: null, nextId: null },
      { index: 0, count: 2, previousId: null, nextId: expect.any(String) },
      { index: 1, count: 2, previousId: expect.any(String), nextId: null },
      { index: 0, count: 1, previousId: null, nextId: null },
    ]);
    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id));
    expect(row?.lastMessageAt).toEqual(lastMessageAt);
  });

  it("lands on the Message itself when it has no children", async () => {
    const { client, conv, q2, a2 } = await branchyConversation();

    await client.conversation.switchBranch({ messageId: q2.id });

    const result = await client.conversation.get({ id: conv.id });
    expect(result.messages.at(-1)?.id).toBe(a2.id);
  });

  it("refuses while a reply is streaming in the Conversation", async () => {
    const { client, conv, a1, a1b } = await branchyConversation();
    await getTestDb().update(message).set({ status: "streaming" }).where(eq(message.id, a1b.id));

    await expect(client.conversation.switchBranch({ messageId: a1.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const result = await client.conversation.get({ id: conv.id });
    expect(result.messages.at(-1)?.id).toBe(a1b.id);
  });

  it("can't switch another user's Conversation", async () => {
    const { conv, a1, a1b } = await branchyConversation();
    const other = await signedIn();

    await expect(
      other.client.conversation.switchBranch({ messageId: a1.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id));
    expect(row?.activeLeafId).toBe(a1b.id);
  });
});

describe("live-listed Models", () => {
  async function withOpenRouter(openRouter: string[]) {
    const user = await insertUser();
    const deps = createTestDeps({ fetch: liveModelsFetch({ openRouter }).fetch });
    await saveCredentials(deps, user.id, {
      service: "openrouter",
      fields: { apiKey: "sk-or-test" },
      hint: "…test",
      verified: true,
    });
    return { user, client: chatRpc({ user, deps }) };
  }

  it("creates a Conversation on a Model from OpenRouter's live list", async () => {
    const { client } = await withOpenRouter(["anthropic/claude-sonnet-5.5"]);

    const { id } = await client.conversation.create({
      model: "openrouter:anthropic/claude-sonnet-5.5",
    });

    await expect(client.conversation.get({ id })).resolves.toMatchObject({
      model: "openrouter:anthropic/claude-sonnet-5.5",
    });
  });

  it("refuses an OpenRouter Model that isn't on the live list", async () => {
    const { client } = await withOpenRouter(["anthropic/claude-sonnet-5.5"]);

    await expect(
      client.conversation.create({ model: "openrouter:openai/gpt-4o" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("selects a Model installed on the user's Ollama host", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ fetch: liveModelsFetch({ ollama: ["qwen3:8b"] }).fetch });
    await saveCredentials(deps, user.id, {
      service: "ollama",
      fields: { host: "http://ollama.test:11434" },
      hint: "http://ollama.test:11434",
      verified: true,
    });
    const client = chatRpc({ user, deps });
    const conv = await insertConversation(user);

    await client.conversation.setModel({ id: conv.id, model: "ollama:qwen3:8b" });

    await expect(client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      model: "ollama:qwen3:8b",
    });
    await expect(
      client.conversation.setModel({ id: conv.id, model: "ollama:llama3.2:latest" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("conversation reasoning effort", () => {
  it("creates a Conversation with the chosen effort, and get returns it", async () => {
    const { client } = await signedIn();
    const { id } = await client.conversation.create({
      model: "anthropic:claude-sonnet-5-5",
      reasoningEffort: "high",
    });

    await expect(client.conversation.get({ id })).resolves.toMatchObject({
      reasoningEffort: "high",
    });
  });

  it("sets the effort on an existing Conversation, and clears it back to the Model's default", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { model: "anthropic:claude-sonnet-5-5" });

    await client.conversation.setReasoningEffort({ id: conv.id, reasoningEffort: "low" });
    await expect(client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      reasoningEffort: "low",
    });

    await client.conversation.setReasoningEffort({ id: conv.id, reasoningEffort: null });
    await expect(client.conversation.get({ id: conv.id })).resolves.toMatchObject({
      reasoningEffort: null,
    });
  });

  it("refuses an effort that isn't one the chat knows", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);

    await expect(
      client.conversation.setReasoningEffort({
        id: conv.id,
        reasoningEffort: "extreme" as "low",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("can't change another user's Conversation's effort", async () => {
    const { client } = await signedIn();
    const conv = await insertConversation(await insertUser());

    await expect(
      client.conversation.setReasoningEffort({ id: conv.id, reasoningEffort: "high" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("conversation.pin and conversation.unpin", () => {
  it("pins a Conversation, so the Pinned read returns it and the main list drops it", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { title: "Daily" });

    await client.conversation.pin({ id: conv.id });

    const pinned = await client.conversation.pinned();
    expect(pinned).toEqual([expect.objectContaining({ id: conv.id, pinnedAt: expect.any(Date) })]);
    expect(await listItems(client)).toEqual([]);
  });

  it("unpins a Conversation, so it returns to the main list and leaves Pinned", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { title: "Daily" });
    await client.conversation.pin({ id: conv.id });

    await client.conversation.unpin({ id: conv.id });

    expect(await client.conversation.pinned()).toEqual([]);
    expect((await listItems(client)).map((row) => row.id)).toEqual([conv.id]);
  });

  it("orders Pinned by when each Conversation was pinned, not by its last Message", async () => {
    const { user, client } = await signedIn();
    const pinnedFirst = await insertConversation(user, {
      title: "Pinned first",
      lastMessageAt: new Date("2026-10-09T10:00:00Z"),
      pinnedAt: new Date("2026-10-01T10:00:00Z"),
    });
    const pinnedLater = await insertConversation(user, {
      title: "Pinned later",
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
      pinnedAt: new Date("2026-10-05T10:00:00Z"),
    });

    expect((await client.conversation.pinned()).map((row) => row.id)).toEqual([
      pinnedLater.id,
      pinnedFirst.id,
    ]);
  });

  it("neither moves a Conversation's last Message time nor the main list's order", async () => {
    const { user, client } = await signedIn();
    const older = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });
    const newer = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-05T10:00:00Z"),
    });

    await client.conversation.pin({ id: older.id });
    const [row] = await getTestDb()
      .select({ lastMessageAt: conversation.lastMessageAt })
      .from(conversation)
      .where(eq(conversation.id, older.id));
    expect(row?.lastMessageAt).toEqual(older.lastMessageAt);
    await client.conversation.unpin({ id: older.id });

    expect((await listItems(client)).map((item) => item.id)).toEqual([newer.id, older.id]);
  });

  it("shows a pinned Conversation inside a Project under Pinned, not in the main list", async () => {
    const { user, client } = await signedIn();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Work" });
    const inProject = await insertConversation(user, {
      title: "In a Project",
      projectId,
      pinnedAt: new Date("2026-10-02T08:00:00Z"),
    });

    expect((await client.conversation.pinned()).map((row) => row.id)).toEqual([inProject.id]);
    expect(await listItems(client)).toEqual([]);
  });

  it("caps pins at 20 and refuses a 21st until one is unpinned", async () => {
    const { user, client } = await signedIn();
    const conversations = [];
    for (let i = 0; i < 21; i++) {
      conversations.push(await insertConversation(user, { title: `Chat ${i}` }));
    }
    for (const conv of conversations.slice(0, 20)) {
      await client.conversation.pin({ id: conv.id });
    }
    const last = conversations[20];
    if (!last) throw new Error("Expected a 21st Conversation");

    await expect(client.conversation.pin({ id: last.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Unpin one first"),
    });

    await client.conversation.unpin({ id: conversations[0]?.id ?? "" });
    await client.conversation.pin({ id: last.id });
    expect(await client.conversation.pinned()).toHaveLength(20);
  });

  it("pinning an already pinned Conversation at the cap is fine and keeps its place", async () => {
    const { user, client } = await signedIn();
    const first = await insertConversation(user, { pinnedAt: new Date("2026-10-01T10:00:00Z") });
    for (let i = 1; i < 20; i++) {
      await insertConversation(user, { pinnedAt: new Date(`2026-10-0${1 + (i % 9)}T11:00:00Z`) });
    }

    await expect(client.conversation.pin({ id: first.id })).resolves.toBeUndefined();
    const pinnedIds = (await client.conversation.pinned()).map((row) => row.id);
    expect(pinnedIds).toContain(first.id);
    expect(pinnedIds).toHaveLength(20);
  });

  it("answers NOT_FOUND when pinning or unpinning another user's Conversation", async () => {
    const owner = await signedIn();
    const conv = await insertConversation(owner.user);
    const other = await signedIn();

    await expect(other.client.conversation.pin({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(other.client.conversation.unpin({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("conversation.move", () => {
  it("moves a Conversation into a Project, so it leaves the main list and shows on the Project's", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const conv = await insertConversation(user, { title: "Daily" });

    await client.conversation.move({ id: conv.id, projectId });

    expect(await listItems(client)).toEqual([]);
    expect((await client.conversation.list({ projectId })).items.map((row) => row.id)).toEqual([
      conv.id,
    ]);
  });

  it("moves a Conversation from one Project to another", async () => {
    const { user, client } = await signedIn();
    const { id: from } = await client.project.create({ name: "From" });
    const { id: to } = await client.project.create({ name: "To" });
    const conv = await insertConversation(user, { projectId: from });

    await client.conversation.move({ id: conv.id, projectId: to });

    expect((await client.conversation.list({ projectId: from })).items).toEqual([]);
    expect((await client.conversation.list({ projectId: to })).items.map((row) => row.id)).toEqual([
      conv.id,
    ]);
  });

  it("moves a Conversation out of its Project back into the main list", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const conv = await insertConversation(user, { projectId });

    await client.conversation.move({ id: conv.id, projectId: null });

    expect((await client.conversation.list({ projectId })).items).toEqual([]);
    expect((await listItems(client)).map((row) => row.id)).toEqual([conv.id]);
  });

  it("leaves the Model, the Messages and lastMessageAt as they were", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const lastMessageAt = new Date("2026-10-03T09:30:00Z");
    const conv = await insertConversation(user, {
      model: "openai:gpt-5.6",
      lastMessageAt,
    });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hello", active: true });

    await client.conversation.move({ id: conv.id, projectId });

    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id));
    expect(row).toMatchObject({ model: "openai:gpt-5.6", projectId, lastMessageAt });
    const after = await client.conversation.get({ id: conv.id });
    expect(after.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps a pinned Conversation pinned when it moves, and still lists it under Pinned", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const conv = await insertConversation(user, { pinnedAt: new Date("2026-10-02T08:00:00Z") });

    await client.conversation.move({ id: conv.id, projectId });

    const pinned = await client.conversation.pinned();
    expect(pinned).toEqual([
      expect.objectContaining({ id: conv.id, projectId, pinnedAt: expect.any(Date) }),
    ]);
    expect((await client.conversation.list({ projectId })).items.map((row) => row.id)).toEqual([
      conv.id,
    ]);
    expect(await listItems(client)).toEqual([]);
  });

  it("answers NOT_FOUND for a Project that belongs to another user", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { title: "Mine" });
    const other = await insertUser();
    const { id: theirs } = await chatRpc({ user: other }).project.create({ name: "Theirs" });

    await expect(
      client.conversation.move({ id: conv.id, projectId: theirs }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id));
    expect(row?.projectId).toBeNull();
  });

  it("answers NOT_FOUND for another user's Conversation, and leaves it where it was", async () => {
    const other = await insertUser();
    const theirConversation = await insertConversation(other, { title: "Theirs" });
    const { client } = await signedIn();
    const { id: mine } = await client.project.create({ name: "Mine" });

    await expect(
      client.conversation.move({ id: theirConversation.id, projectId: mine }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.conversation.move({ id: theirConversation.id, projectId: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await getTestDb()
      .select()
      .from(conversation)
      .where(eq(conversation.id, theirConversation.id));
    expect(row?.projectId).toBeNull();
  });
});
