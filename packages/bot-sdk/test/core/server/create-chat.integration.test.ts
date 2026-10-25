import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { saveCredentials } from "../../../plugins/models/server/internal";
import { createTestSdk } from "../../support/deps";
import { createTestChat } from "../../support/sdk";
import { insertUser } from "../../support/users";
import { testDatabaseUrl } from "../../support/test-database";

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
        models: {},
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
        models: {},
      }),
    ).toThrow(/at least one/);
  });
});

// start() checks the schema before any part, so these run on the migrated test database.
describe("createBotSdk start", () => {
  it("refuses to start with neither Host credentials nor BYOK", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      models: {
        byok: false,
      },
    });

    await expect(chat.start()).rejects.toThrow(/hostProviders|byok/);
  });

  it("refuses a defaultImageModel that is not one of the Host's Image Models", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      models: {
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
      },
    });

    await expect(chat.start()).rejects.toThrow(/defaultImageModel/);
  });

  it("refuses a Host Image Model without a pricePerImageUsd", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      models: {
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
      },
    });

    await expect(chat.start()).rejects.toThrow(/pricePerImageUsd/);
  });
});

describe("an instance with no feature", () => {
  it("serves the models procedures", async () => {
    const user = await insertUser();
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: user.id }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath,
      models: {},
    });

    const response = await chat.handler(
      new Request(`${baseUrl}/rpc/credentials/mode`, { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: { byok: true } });
  });
});

describe("the chat handler", () => {
  it("answers 401 to an RPC call or a plugin's route without a user", async () => {
    const client = createTestChat({ user: null, deps: createTestSdk() });

    const rpc = await client.fetch(
      new Request(`${baseUrl}/rpc/bot/list`, { method: "POST", body: "{}" }),
    );
    const route = await client.fetch(new Request(`${baseUrl}/bot-files/x`));

    expect([rpc.status, route.status]).toEqual([401, 401]);
  });

  it("round trips an RPC call for the signed-in user", async () => {
    const user = await insertUser();
    const deps = createTestSdk();
    const client = createTestChat({ user, deps }).rpc;
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    const { id } = await client.bot.create({ name: "Ada", model: "anthropic:claude-sonnet-5-5" });

    expect((await client.bot.list()).map((listed) => listed.id)).toEqual([id]);
  });
});
