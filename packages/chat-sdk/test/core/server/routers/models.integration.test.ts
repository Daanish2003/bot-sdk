import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { liveModelsFetch } from "../../../support/live-models";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

const deps = createTestDeps();

async function addCredentials(user: TestUser, service: "anthropic" | "openai") {
  await saveCredentials(deps, user.id, {
    service,
    fields: { apiKey: `${service}-test-key` },
    hint: "…-key",
    verified: true,
  });
}

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user, deps }) };
}

describe("models.list", () => {
  it("returns only the Models of Providers the user has credentials for, with capability flags", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    const { models } = await client.models.list();

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === "openai")).toBe(true);
    expect(models).toContainEqual({
      id: "openai:gpt-5.6",
      provider: "openai",
      modelId: "gpt-5.6",
      label: "GPT-5.6",
      images: true,
      pdfs: false,
      tools: true,
      onHostCredentials: false,
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      reasoning: { efforts: ["low", "medium", "high"], off: true, defaultEffort: null },
    });
  });

  it("returns no Models and no default without credentials", async () => {
    const { client } = await signedIn();

    await expect(client.models.list()).resolves.toEqual({
      models: [],
      defaultModel: null,
      webSearchOnHost: false,
    });
  });

  it("defaults a new Conversation to the code default of the first Provider the user added", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");
    await addCredentials(user, "anthropic");

    const { defaultModel } = await client.models.list();

    expect(defaultModel).toBe("openai:gpt-5.6");
  });

  it("defaults a new Conversation to the Model of the user's most recent Conversation", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");
    await addCredentials(user, "anthropic");
    await insertConversation(user, {
      model: "anthropic:claude-haiku-4-5",
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });
    await insertConversation(user, {
      model: "anthropic:claude-opus-5-5",
      lastMessageAt: new Date("2026-10-02T10:00:00Z"),
    });

    const { defaultModel } = await client.models.list();

    expect(defaultModel).toBe("anthropic:claude-opus-5-5");
  });

  it("skips the most recent Conversation's Model when its Provider has no credentials any more", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "anthropic");
    await insertConversation(user, { model: "openai:gpt-6-luna" });

    const { defaultModel } = await client.models.list();

    expect(defaultModel).toBe("anthropic:claude-sonnet-5-5");
  });

  it("ignores other users' Conversations", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "anthropic");
    const other = await insertUser();
    await insertConversation(other, { model: "anthropic:claude-opus-5-5" });

    const { defaultModel } = await client.models.list();

    expect(defaultModel).toBe("anthropic:claude-sonnet-5-5");
  });

  it("rejects a caller without a session", async () => {
    await expect(chatRpc({ deps }).models.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("models.list with live lists", () => {
  async function signedInWith(fetch: typeof globalThis.fetch) {
    const user = await insertUser();
    const liveDeps = createTestDeps({ fetch });
    return { user, deps: liveDeps, client: chatRpc({ user, deps: liveDeps }) };
  }

  it("lists OpenRouter's live Models for a user with OpenRouter credentials", async () => {
    const live = liveModelsFetch({ openRouter: ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5"] });
    const { user, deps: liveDeps, client } = await signedInWith(live.fetch);
    await saveCredentials(liveDeps, user.id, {
      service: "openrouter",
      fields: { apiKey: "sk-or-test" },
      hint: "…test",
      verified: true,
    });

    const { models, defaultModel } = await client.models.list();

    expect(models.map((model) => model.id)).toEqual([
      "openrouter:anthropic/claude-sonnet-5.5",
      "openrouter:openai/gpt-5.5",
    ]);
    expect(models[0]).toMatchObject({ provider: "openrouter", pdfs: false, tools: true });
    expect(defaultModel).toBe("openrouter:anthropic/claude-sonnet-5.5");
  });

  it("lists the Models installed on the user's Ollama host, the first one as the default", async () => {
    const live = liveModelsFetch({ ollama: ["qwen3:8b", "llama3.2:latest"] });
    const { user, deps: liveDeps, client } = await signedInWith(live.fetch);
    await saveCredentials(liveDeps, user.id, {
      service: "ollama",
      fields: { host: "http://ollama.test:11434" },
      hint: "http://ollama.test:11434",
      verified: true,
    });

    const { models, defaultModel } = await client.models.list();

    expect(live.urls).toEqual(["http://ollama.test:11434/api/tags"]);
    expect(models).toEqual([
      {
        id: "ollama:qwen3:8b",
        provider: "ollama",
        modelId: "qwen3:8b",
        label: "qwen3:8b",
        images: false,
        pdfs: false,
        tools: true,
        onHostCredentials: false,
        contextWindow: null,
        maxOutputTokens: null,
        reasoning: { efforts: [], off: false, defaultEffort: null },
      },
      expect.objectContaining({ id: "ollama:llama3.2:latest" }),
    ]);
    expect(defaultModel).toBe("ollama:qwen3:8b");
  });

  it("doesn't fetch live lists for a user without OpenRouter or Ollama credentials", async () => {
    const live = liveModelsFetch({ openRouter: ["openai/gpt-5.5"] });
    const { user, deps: liveDeps, client } = await signedInWith(live.fetch);
    await saveCredentials(liveDeps, user.id, {
      service: "gemini",
      fields: { apiKey: "AIza-test" },
      hint: "…test",
      verified: true,
    });

    const { models, defaultModel } = await client.models.list();

    expect(live.urls).toEqual([]);
    expect(models.every((model) => model.provider === "gemini")).toBe(true);
    expect(defaultModel).toBe("gemini:gemini-3.8-flash");
  });
});

describe("models.list with Host credentials", () => {
  const hostProviders = [
    {
      provider: "anthropic" as const,
      credentials: { apiKey: "sk-ant-host" },
      models: [
        {
          modelId: "claude-haiku-4-5",
          maxOutputTokens: 512,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 5,
        },
      ],
    },
  ];

  it("lists the Host Models marked as Host Models for a user without credentials, and defaults to one", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders });

    const { models, defaultModel } = await chatRpc({ user, deps }).models.list();

    expect(models).toEqual([
      {
        id: "anthropic:claude-haiku-4-5",
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        images: true,
        pdfs: true,
        tools: true,
        onHostCredentials: true,
        // The window and efforts fall back to the curated Model; the output is the Host's cap.
        contextWindow: 200000,
        maxOutputTokens: 512,
        reasoning: { efforts: [], off: false, defaultEffort: null },
      },
    ]);
    expect(defaultModel).toBe("anthropic:claude-haiku-4-5");
  });

  it("merges the Host Models with the user's own Models, and the user's own Provider wins", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders });
    await addCredentials(user, "openai");
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own" },
      hint: "…-own",
      verified: true,
    });

    const { models, defaultModel } = await chatRpc({ user, deps }).models.list();

    expect(models.filter((model) => model.onHostCredentials)).toEqual([]);
    expect(models.some((model) => model.id === "anthropic:claude-haiku-4-5")).toBe(true);
    expect(defaultModel).toBe("openai:gpt-5.6");
  });

  it("lists a Host Model of a Provider the user has no key for, beside the user's own Models", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ hostProviders });
    await addCredentials(user, "openai");

    const { models } = await chatRpc({ user, deps }).models.list();

    expect(models.find((model) => model.id === "anthropic:claude-haiku-4-5")).toMatchObject({
      onHostCredentials: true,
    });
    expect(models.find((model) => model.id === "openai:gpt-5.6")).toMatchObject({
      onHostCredentials: false,
    });
  });

  it("says web search is on the Host when the Host offers a Tavily key", async () => {
    const user = await insertUser();
    const hosted = createTestDeps({
      hostTools: [
        { tool: "tavily", credentials: { apiKey: "tvly-host" }, pricePerSearchUsd: 0.008 },
      ],
    });

    await expect(chatRpc({ user, deps: hosted }).models.list()).resolves.toMatchObject({
      webSearchOnHost: true,
    });
  });
});
