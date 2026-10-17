import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { runner } from "../../../plugins/runner/server/plugin";
import { models } from "../../../plugins/models/server/plugin";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import { message } from "../../../core/server/db/schema";
import { eq } from "drizzle-orm";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { createFakeAdapter, round, text } from "../../support/fake-adapter";
import { insertUser } from "../../support/users";
import { createTestChat } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";

const basePath = "/api/chat";
const baseUrl = `http://localhost${basePath}`;

describe("createBotSdk", () => {
  it("opens no connection until the first request", () => {
    expect(() =>
      createBotSdk({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        basePath,
        plugins: [models(), runner(), assistant()],
      }),
    ).not.toThrow();
  });

  it("rejects an empty keyring", () => {
    expect(() =>
      createBotSdk({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: [],
        basePath,
        plugins: [models(), runner(), assistant()],
      }),
    ).toThrow(/at least one/);
  });

  it("throws when the assistant is enabled without the runner", () => {
    expect(() =>
      createBotSdk({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        basePath,
        plugins: [models(), assistant()],
      }),
    ).toThrow(/Plugin "assistant" requires plugin "runner"/);
  });
});

// start() checks the schema before any plugin, so these run on the migrated test database.
describe("createBotSdk start", () => {
  it("refuses to start with neither Host credentials nor BYOK", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [
        models({
          byok: false,
        }),
        runner(),
        assistant(),
      ],
    });

    await expect(chat.start()).rejects.toThrow(/hostProviders|byok/);
  });

  it("refuses transcription Models on a Provider with no transcription adapter", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [
        models({
          hostProviders: [
            {
              provider: "anthropic",
              credentials: { apiKey: "sk-host" },
              models: [],
              transcriptionModels: [{ model: "some-model", pricePerMinuteUsd: 0.01 }],
            },
          ],
        }),
        runner(),
        assistant(),
      ],
    });

    await expect(chat.start()).rejects.toThrow(/anthropic.*transcription/);
  });

  it("refuses a defaultBackgroundModel that is not one of the Host's Models", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [
        models({
          hostProviders: [
            {
              provider: "ollama",
              credentials: { host: "http://localhost:11434" },
              models: [
                {
                  modelId: "llama",
                  maxOutputTokens: 512,
                  inputUsdPerMillion: 0,
                  outputUsdPerMillion: 0,
                },
              ],
            },
          ],
          defaultBackgroundModel: "ollama:mistral",
        }),
        runner(),
        assistant(),
      ],
    });

    await expect(chat.start()).rejects.toThrow(/defaultBackgroundModel/);
  });

  it("refuses a defaultImageModel that is not one of the Host's Image Models", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [
        models({
          hostProviders: [
            {
              provider: "openai",
              credentials: { apiKey: "host-key" },
              models: [],
              imageModels: [
                {
                  modelId: "gpt-image-1-mini",
                  size: "1024x1024",
                  quality: "medium",
                  pricePerImageUsd: 0.01,
                },
              ],
            },
          ],
          defaultImageModel: "openai:gpt-image-2",
        }),
        runner(),
        assistant(),
      ],
    });

    await expect(chat.start()).rejects.toThrow(/defaultImageModel/);
  });

  it("refuses a Host Image Model without a pricePerImageUsd", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [
        models({
          hostProviders: [
            {
              provider: "openai",
              credentials: { apiKey: "host-key" },
              models: [],
              imageModels: [
                // Left unpriced on purpose: a JavaScript Host can omit what TypeScript requires.
                { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium" } as never,
              ],
            },
          ],
        }),
        runner(),
        assistant(),
      ],
    });

    await expect(chat.start()).rejects.toThrow(/pricePerImageUsd/);
  });
});

describe("an instance with only the models plugin", () => {
  it("serves the models procedures", async () => {
    const user = await insertUser();
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: user.id }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      plugins: [models()],
    });

    const response = await chat.handler(
      new Request(`${baseUrl}/rpc/credentials/mode`, { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: { byok: true } });
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
    const deps = createTestSdk({ adapterFor: () => fake.adapter });
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
    const deps = createTestSdk();
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
