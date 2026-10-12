import { describe, expect, it } from "vitest";

import { createChat } from "../../../core/server/create-chat";
import { saveCredentials } from "../../../core/server/credentials/store";
import { message } from "../../../core/server/db/schema/chat";
import { eq } from "drizzle-orm";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
import { createFakeAdapter, round, text } from "../../support/fake-adapter";
import { insertUser } from "../../support/users";
import { createTestChat } from "../../support/sdk";
import { getTestDb } from "../../support/test-database";

const basePath = "/api/chat";
const baseUrl = `http://localhost${basePath}`;

describe("createChat", () => {
  it("opens no connection until the first request", () => {
    expect(() =>
      createChat({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        basePath,
      }),
    ).not.toThrow();
  });

  it("rejects an empty keyring", () => {
    expect(() =>
      createChat({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: [],
        basePath,
      }),
    ).toThrow(/at least one/);
  });
});

describe("createChat start", () => {
  it("refuses to start with neither Host credentials nor BYOK", async () => {
    const chat = createChat({
      databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      byok: false,
    });

    await expect(chat.start()).rejects.toThrow(/hostProviders|byok/);
  });
});

describe("the chat handler", () => {
  it("answers 401 to every request without a user, except the public Shared link read", async () => {
    const client = createTestChat({ user: null });

    const rpc = await client.fetch(
      new Request(`${baseUrl}/rpc/healthCheck`, { method: "POST", body: "{}" }),
    );
    const run = await client.fetch(new Request(client.chatUrl, { method: "POST", body: "{}" }));
    const join = await client.fetch(new Request(`${client.chatUrl}?runId=x`));

    expect([rpc.status, run.status, join.status]).toEqual([401, 401, 401]);
  });

  it("round trips an RPC call for the signed-in user", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Hello" });

    const list = (await createTestChat({ user }).rpc.conversation.list({})).items;

    expect(list.map(({ id }) => id)).toEqual([conv.id]);
  });

  it("streams a Run through the handler and saves its reply", async () => {
    const user = await insertUser();
    const fake = createFakeAdapter({ rounds: [round(text("Hello", " there!"))] });
    const deps = createTestDeps({ adapterFor: () => fake.adapter });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    // A titled Conversation, so no automatic title call takes the scripted adapter.
    const conv = await insertConversation(user, { title: "Test Conversation" });
    const client = createTestChat({ user, deps });

    const response = await client.fetch(
      new Request(client.chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Hi",
            attachmentIds: [],
            model: "anthropic:claude-sonnet-5-5",
            webSearch: false,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"delta":" there!"');
    const replies = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(replies.map(({ role, status }) => [role, status]).sort()).toEqual([
      ["assistant", "complete"],
      ["user", "complete"],
    ]);
    // The reply's heartbeat was set when its Run started (ADR 0006).
    expect(replies.find(({ role }) => role === "assistant")?.heartbeatAt).toBeInstanceOf(Date);
  });

  it("serves a Shared link to a caller without a user", async () => {
    const owner = await insertUser();
    const deps = createTestDeps();
    const conv = await insertConversation(owner, { title: "Recursive CTEs" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });
    const link = await createTestChat({ user: owner, deps }).rpc.share.upsert({
      conversationId: conv.id,
    });

    const shared = await createTestChat({ user: null, deps }).rpc.share.get({ token: link.token });

    expect(shared.title).toBe("Recursive CTEs");
    expect(shared.messages.map(({ parts }) => parts)).toEqual([[{ type: "text", content: "Hi" }]]);
  });
});
