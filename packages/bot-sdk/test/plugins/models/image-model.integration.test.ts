import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";

import { modelSettings } from "../../../core/server/storage";
import { saveCredentials } from "../../../plugins/models/server/internal";
import type { HostProvider } from "../../../plugins/models/server/internal";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { insertUser, type TestUser } from "../../support/users";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";

// The Host's Image Model is Gemini's, so the tests can tell it from the user's own OpenAI key.
const hostProviders: HostProvider[] = [
  {
    provider: "gemini",
    credentials: { apiKey: "host-gemini-key" },
    models: [],
    imageModels: [
      {
        modelId: "gemini-3.1-flash-image",
        size: "1024x1024",
        quality: "medium",
        pricePerImageUsd: 0.04,
      },
    ],
  },
];
const deps = createTestSdk({ hostProviders });

async function addCredentials(user: TestUser, service: "openai") {
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

describe("models.setImageModel", () => {
  it("saves a curated Image Model the user has credentials for", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await client.models.setImageModel({ imageModel: "openai:gpt-image-1-mini" });

    await expect(client.models.imageModel()).resolves.toMatchObject({
      imageModel: "openai:gpt-image-1-mini",
    });
  });

  it("saves one of the Host's Image Models without the user's own credentials", async () => {
    const { client } = await signedIn();

    await client.models.setImageModel({ imageModel: "gemini:gemini-3.1-flash-image" });

    await expect(client.models.imageModel()).resolves.toMatchObject({
      imageModel: "gemini:gemini-3.1-flash-image",
    });
  });

  it("clears the Image Model back to the Host's default", async () => {
    const { client } = await signedIn();
    await client.models.setImageModel({ imageModel: "gemini:gemini-3.1-flash-image" });

    await client.models.setImageModel({ imageModel: null });

    await expect(client.models.imageModel()).resolves.toMatchObject({ imageModel: null });
  });

  it("reads and writes the models plugin's model_settings, not the assistant's settings (#803)", async () => {
    const { user, client } = await signedIn();
    // A pick the migration copied over.
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: user.id, imageModel: "gemini:gemini-3.1-flash-image" });

    await expect(client.models.imageModel()).resolves.toMatchObject({
      imageModel: "gemini:gemini-3.1-flash-image",
    });

    await client.models.setImageModel({ imageModel: null });

    await expect(
      getTestDb().select({ imageModel: modelSettings.imageModel }).from(modelSettings),
    ).resolves.toEqual([{ imageModel: null }]);
  });

  it("rejects an id that is not an Image Model", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await expect(client.models.setImageModel({ imageModel: "openai:nope" })).rejects.toThrow(
      /not an available Image Model/,
    );
  });

  it("rejects a chat-only Model", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await expect(client.models.setImageModel({ imageModel: "openai:gpt-6-luna" })).rejects.toThrow(
      /not an available Image Model/,
    );
  });

  it("rejects a curated Image Model of a Provider the user has no credentials for", async () => {
    const { client } = await signedIn();

    await expect(
      client.models.setImageModel({ imageModel: "openai:gpt-image-1-mini" }),
    ).rejects.toThrow(/not an available Image Model/);
    await expect(client.models.imageModel()).resolves.toMatchObject({ imageModel: null });
  });

  it("lists the user's own Image Models first, then the Host's, marked as on Host credentials", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    const { imageModels, defaultImageModel } = await client.models.list();

    expect(defaultImageModel).toBeNull();
    expect(imageModels.map((model) => [model.id, model.onHostCredentials])).toEqual([
      ["openai:gpt-image-2", false],
      ["openai:gpt-image-1-mini", false],
      ["openai:dall-e-3", false],
      ["gemini:gemini-3.1-flash-image", true],
    ]);
  });
});

describe("createBotSdk().users.export, the models plugin", () => {
  const exportFor = (userId: string) =>
    createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      models: {},
    }).users.export({ userId });

  it("exports the Image Model under the models section", async () => {
    const user = await insertUser();
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: user.id, imageModel: "openai:gpt-image-2" });

    const document = await exportFor(user.id);

    expect(document.models).toEqual({ imageModel: "openai:gpt-image-2" });
  });

  it("exports no Image Model for a user who picked none", async () => {
    const document = await exportFor(randomUUID());

    expect(document.models).toEqual({ imageModel: null });
  });
});
