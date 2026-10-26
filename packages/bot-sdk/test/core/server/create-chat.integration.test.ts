import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createHttpHandler } from "../../../core/http";
import { createBotSdk, httpPartsOf } from "../../../core/server/create-chat";
import { postgres } from "../../../core/server/database";
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
        database: postgres({
          connectionString: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        }),
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        models: {},
      }),
    ).not.toThrow();
  });

  it("rejects an empty keyring", () => {
    expect(() =>
      createBotSdk({
        database: postgres({
          connectionString: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        }),
        keyEncryptionSecrets: [],
        models: {},
      }),
    ).toThrow(/at least one/);
  });
});

describe("the database slot", () => {
  const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

  it("takes a connection string", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });

    await sdk.migrate();
    await sdk.start();
    try {
      expect(await sdk.users.export({ userId: user.id })).toMatchObject({ version: 2 });
    } finally {
      await sdk.stop();
    }
  });

  it("takes the Host's own pg Pool, and queries through it", async () => {
    const user = await insertUser();
    const pool = new pg.Pool({ connectionString: testDatabaseUrl });
    try {
      const sdk = createBotSdk({ database: postgres({ pool }), keyEncryptionSecrets, models: {} });

      await sdk.migrate();
      await sdk.start();
      const acquired = vi.fn();
      pool.on("acquire", acquired);
      try {
        expect(await sdk.users.export({ userId: user.id })).toMatchObject({ version: 2 });
      } finally {
        await sdk.stop();
      }
      expect(acquired).toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  });
});

describe("the pool the SDK owns", () => {
  const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

  it("leaves the Host's pool alone: no error listener, and stop() never ends it", async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl });
    try {
      const listeners = pool.listenerCount("error");
      const sdk = createBotSdk({ database: postgres({ pool }), keyEncryptionSecrets, models: {} });
      expect(pool.listenerCount("error")).toBe(listeners);

      await sdk.stop();
      expect(pool.ended).toBe(false);
      await expect(pool.query("select 1")).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  it("logs an idle connection's failure on its own pool instead of crashing", () => {
    const logger = { error: vi.fn() };
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      logger,
      models: {},
    });
    const own = httpPartsOf(sdk).context.db.$client;

    const failure = new Error("terminating connection due to administrator command");
    expect(() => own.emit("error", failure)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("botsdk"), failure);
  });

  it("ends the pool it opened from a connection string on stop()", async () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const own = httpPartsOf(sdk).context.db.$client;
    await own.query("select 1");

    await sdk.stop();
    expect(own.ended).toBe(true);
  });
});

// start() checks the schema before any part, so these run on the migrated test database.
describe("createBotSdk start", () => {
  it("refuses to start with neither Host credentials nor BYOK", async () => {
    const chat = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      models: {
        byok: false,
      },
    });

    await expect(chat.start()).rejects.toThrow(/hostProviders|byok/);
  });

  it("refuses a defaultImageModel that is not one of the Host's Image Models", async () => {
    const chat = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
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
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
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
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      models: {},
    });

    const http = createHttpHandler(chat, { basePath, getUser: () => ({ id: user.id }) });

    const response = await http(
      new Request(`${baseUrl}/rpc/models/credentials/mode`, { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: { byok: true } });
  });
});

describe("the chat handler", () => {
  it("answers 401 to an RPC call or a plugin's route without a user", async () => {
    const client = createTestChat({ user: null, deps: createTestSdk() });

    const rpc = await client.fetch(
      new Request(`${baseUrl}/rpc/bots/list`, { method: "POST", body: "{}" }),
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
    const { id } = await client.bots.create({ name: "Ada", model: "anthropic:claude-sonnet-5-5" });

    expect((await client.bots.list()).map((listed) => listed.id)).toEqual([id]);
  });
});
