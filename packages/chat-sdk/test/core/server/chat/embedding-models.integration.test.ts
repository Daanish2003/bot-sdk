import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  defaultEmbeddingModel,
  embedTexts,
  resolveEmbeddingModel,
} from "../../../../core/server/chat/embedding-models";
import { fakeEmbeddingAdapter } from "../../../../core/server/chat/fake-embedding-adapter";
import { createHookEmitter } from "../../../../core/server/chat/hooks";
import { createChat } from "../../../../core/server/create-chat";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { usage } from "../../../../core/server/db/schema/usage";
import type { HostProvider } from "../../../../core/server/deps";
import { createTestDeps, testKeyEncryptionSecret } from "../../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-large", pricePerMillionTokensUsd: 0.13 }],
};

const hostGemini: HostProvider = {
  provider: "gemini",
  credentials: { apiKey: "gemini-host-key" },
  models: [],
  embeddingModels: [{ model: "gemini-embedding-001", pricePerMillionTokensUsd: 0.15 }],
};

/** Saves the user's own key for a Provider, as the keys page does. */
async function saveOwnKey(userId: string, service: "openai" | "gemini") {
  await saveCredentials(createTestDeps(), userId, {
    service,
    fields: { apiKey: `${service}-own-key` },
    hint: "…-key",
    verified: true,
  });
}

/** The usage rows a user has, in no particular order. */
function usageRowsOf(userId: string) {
  return getTestDb().select().from(usage).where(eq(usage.userId, userId));
}

describe("the default embedding Model", () => {
  it("is OpenAI's small Model on the user's own OpenAI key, which wins over the Host's", async () => {
    const user = await insertUser();
    await saveOwnKey(user.id, "openai");
    const deps = createTestDeps({ hostProviders: [hostOpenAI] });

    const model = await defaultEmbeddingModel(deps, user.id);

    expect(model).toMatchObject({ id: "openai:text-embedding-3-small", onHostCredentials: false });
    expect(model?.credentials).toEqual({ apiKey: "openai-own-key" });
  });

  it("is Gemini's Model on the user's own Gemini key when there is no OpenAI key", async () => {
    const user = await insertUser();
    await saveOwnKey(user.id, "gemini");

    const model = await defaultEmbeddingModel(createTestDeps(), user.id);

    expect(model).toMatchObject({ id: "gemini:gemini-embedding-001", onHostCredentials: false });
  });

  it("is the Host's first embedding Model, priced, when the user has no key", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders: [hostGemini, hostOpenAI] });

    const model = await defaultEmbeddingModel(deps, user.id);

    expect(model).toMatchObject({
      id: "gemini:gemini-embedding-001",
      onHostCredentials: true,
      pricePerMillionTokensUsd: 0.15,
      credentials: { apiKey: "gemini-host-key" },
    });
  });

  it("is none when there is no key and the Host offers no embedding Model", async () => {
    const user = await insertUser();

    expect(await defaultEmbeddingModel(createTestDeps(), user.id)).toBeNull();
  });

  it("ignores the user's own key when the Host turns BYOK off", async () => {
    const user = await insertUser();
    await saveOwnKey(user.id, "openai");
    const deps = createTestDeps({ hostProviders: [hostOpenAI], byok: false });

    const model = await defaultEmbeddingModel(deps, user.id);

    expect(model).toMatchObject({ id: "openai:text-embedding-3-large", onHostCredentials: true });
  });
});

describe("the credentials for an embedding Model", () => {
  it("uses the user's own key for the Model, even when the Host offers it", async () => {
    const user = await insertUser();
    await saveOwnKey(user.id, "openai");
    const deps = createTestDeps({ hostProviders: [hostOpenAI] });

    const model = await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-3-large");

    expect(model).toMatchObject({
      onHostCredentials: false,
      credentials: { apiKey: "openai-own-key" },
    });
  });

  it("uses the Host's credentials for a Model the Host offers, with its price", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders: [hostOpenAI] });

    const model = await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-3-large");

    expect(model).toMatchObject({
      onHostCredentials: true,
      pricePerMillionTokensUsd: 0.13,
      credentials: { apiKey: "sk-host-openai" },
    });
  });

  it("is none for a Model the Host doesn't offer, or one that is not an embedding Model", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders: [hostOpenAI] });

    expect(await resolveEmbeddingModel(deps, user.id, "gemini:gemini-embedding-001")).toBeNull();
    expect(await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-ada-002")).toBeNull();
  });
});

/** `count` text inputs, each a few words long. */
function inputs(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `passage ${i} about red guitars`);
}

describe("embedTexts", () => {
  it("embeds on Host credentials, meters the tokens in one usage row and fires onUsage", async () => {
    const user = await insertUser();
    const onUsage = vi.fn();
    const adapter = fakeEmbeddingAdapter({ model: "text-embedding-3-large" });
    const deps = createTestDeps({
      hostProviders: [hostOpenAI],
      embeddingAdapterFor: () => adapter,
      hooks: createHookEmitter({ onUsage }, { error: () => {} }),
    });
    const model = await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-3-large");
    const texts = ["a red guitar", "a blue drum kit"];

    const vectors = await embedTexts(deps, {
      userId: user.id,
      model: model!,
      texts,
      purpose: "document",
    });

    expect(vectors).toHaveLength(2);
    expect(vectors.every((vector) => vector.length === 1536)).toBe(true);
    expect(adapter.calls).toEqual([expect.objectContaining({ inputs: texts, dimensions: 1536 })]);
    const tokens = Math.ceil(texts.join("").length / 4);
    const rows = await usageRowsOf(user.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "embedding",
        model: "openai:text-embedding-3-large",
        inputTokens: tokens,
        outputTokens: 0,
        costMicros: Math.round(tokens * 0.13),
        estimated: false,
      }),
    ]);
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledWith(rows[0]));
  });

  it("embeds on the user's own key with no usage row and no onUsage", async () => {
    const user = await insertUser();
    await saveOwnKey(user.id, "openai");
    const onUsage = vi.fn();
    const deps = createTestDeps({
      hostProviders: [hostOpenAI],
      embeddingAdapterFor: () => fakeEmbeddingAdapter(),
      hooks: createHookEmitter({ onUsage }, { error: () => {} }),
    });
    const model = await defaultEmbeddingModel(deps, user.id);

    await embedTexts(deps, {
      userId: user.id,
      model: model!,
      texts: ["a red guitar"],
      purpose: "query",
    });

    expect(await usageRowsOf(user.id)).toEqual([]);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("estimates Gemini's tokens from characters, marks them estimated, and asks for the task type", async () => {
    const user = await insertUser();
    const adapter = fakeEmbeddingAdapter({ model: "gemini-embedding-001" });
    const deps = createTestDeps({
      hostProviders: [hostGemini],
      embeddingAdapterFor: () => adapter,
    });
    const model = await resolveEmbeddingModel(deps, user.id, "gemini:gemini-embedding-001");
    const texts = ["a red guitar"];

    await embedTexts(deps, { userId: user.id, model: model!, texts, purpose: "document" });
    await embedTexts(deps, { userId: user.id, model: model!, texts, purpose: "query" });

    expect(adapter.calls.map((call) => call.modelOptions)).toEqual([
      { taskType: "RETRIEVAL_DOCUMENT" },
      { taskType: "RETRIEVAL_QUERY" },
    ]);
    const rows = await usageRowsOf(user.id);
    expect(rows).toHaveLength(2);
    const tokens = Math.ceil("a red guitar".length / 4);
    expect(rows[0]).toMatchObject({
      kind: "embedding",
      model: "gemini:gemini-embedding-001",
      inputTokens: tokens,
      estimated: true,
      costMicros: Math.round(tokens * 0.15),
    });
  });

  it("returns unit vectors even when the adapter's vectors are not", async () => {
    const user = await insertUser();
    const fake = fakeEmbeddingAdapter({ model: "gemini-embedding-001" });
    const scaled = {
      ...fake,
      createEmbeddings: async (options: Parameters<typeof fake.createEmbeddings>[0]) => {
        const result = await fake.createEmbeddings(options);
        return {
          ...result,
          embeddings: result.embeddings.map((e) => ({
            ...e,
            vector: e.vector.map((value) => value * 3),
          })),
        };
      },
    } as unknown as typeof fake;
    const deps = createTestDeps({ hostProviders: [hostGemini], embeddingAdapterFor: () => scaled });
    const model = await resolveEmbeddingModel(deps, user.id, "gemini:gemini-embedding-001");

    const [vector] = await embedTexts(deps, {
      userId: user.id,
      model: model!,
      texts: ["a red guitar"],
      purpose: "document",
    });

    expect(Math.hypot(...vector!)).toBeCloseTo(1, 10);
  });

  it("splits OpenAI inputs at 2,048 per request and Gemini's at 100", async () => {
    const user = await insertUser();
    const openAIAdapter = fakeEmbeddingAdapter({ model: "text-embedding-3-large" });
    const geminiAdapter = fakeEmbeddingAdapter({ model: "gemini-embedding-001" });
    const deps = createTestDeps({
      hostProviders: [hostOpenAI, hostGemini],
      embeddingAdapterFor: (model) => (model.startsWith("openai") ? openAIAdapter : geminiAdapter),
    });
    const openAI = await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-3-large");
    const gemini = await resolveEmbeddingModel(deps, user.id, "gemini:gemini-embedding-001");

    const openAIVectors = await embedTexts(deps, {
      userId: user.id,
      model: openAI!,
      texts: inputs(2_049),
      purpose: "document",
    });
    const geminiVectors = await embedTexts(deps, {
      userId: user.id,
      model: gemini!,
      texts: inputs(150),
      purpose: "document",
    });

    expect(openAIVectors).toHaveLength(2_049);
    expect(openAIAdapter.calls.map((call) => call.inputs.length)).toEqual([2_048, 1]);
    expect(geminiVectors).toHaveLength(150);
    expect(geminiAdapter.calls.map((call) => call.inputs.length)).toEqual([100, 50]);
  });

  it("meters nothing when the Provider refuses the call", async () => {
    const user = await insertUser();
    const adapter = fakeEmbeddingAdapter({ model: "text-embedding-3-large", fail: "rate limited" });
    const deps = createTestDeps({
      hostProviders: [hostOpenAI],
      embeddingAdapterFor: () => adapter,
    });
    const model = await resolveEmbeddingModel(deps, user.id, "openai:text-embedding-3-large");

    await expect(
      embedTexts(deps, {
        userId: user.id,
        model: model!,
        texts: ["a red guitar"],
        purpose: "document",
      }),
    ).rejects.toThrow("rate limited");
    expect(await usageRowsOf(user.id)).toEqual([]);
  });
});

describe("hostProviders embeddingModels", () => {
  it("is refused for a Provider other than OpenAI or Gemini", async () => {
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: "unused" }),
      keyEncryptionSecrets: [testKeyEncryptionSecret],
      basePath: "/api/chat",
      logger: { error: () => {} },
      hostProviders: [
        {
          provider: "anthropic",
          credentials: { apiKey: "sk-ant" },
          models: [],
          embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
        },
      ],
    });

    await expect(chat.start()).rejects.toThrow(/embeddingModels/);
  });

  it("is refused for a model the OpenAI embedding adapter doesn't serve", async () => {
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: "unused" }),
      keyEncryptionSecrets: [testKeyEncryptionSecret],
      basePath: "/api/chat",
      logger: { error: () => {} },
      hostProviders: [
        {
          provider: "openai",
          credentials: { apiKey: "sk-openai" },
          models: [],
          embeddingModels: [{ model: "text-embedding-ada-002", pricePerMillionTokensUsd: 0.1 }],
        },
      ],
    });

    await expect(chat.start()).rejects.toThrow(/text-embedding-ada-002/);
  });
});
