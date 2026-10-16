import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { HostProvider } from "../../../../core/server/deps";
import { createTestSdk } from "../../../support/deps";
import { chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

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

describe("settings.setImageModel", () => {
  it("saves a curated Image Model the user has credentials for", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await client.settings.setImageModel({ imageModel: "openai:gpt-image-1-mini" });

    await expect(client.settings.get()).resolves.toMatchObject({
      imageModel: "openai:gpt-image-1-mini",
    });
  });

  it("saves one of the Host's Image Models without the user's own credentials", async () => {
    const { client } = await signedIn();

    await client.settings.setImageModel({ imageModel: "gemini:gemini-3.1-flash-image" });

    await expect(client.settings.get()).resolves.toMatchObject({
      imageModel: "gemini:gemini-3.1-flash-image",
    });
  });

  it("clears the Image Model back to the Host's default", async () => {
    const { client } = await signedIn();
    await client.settings.setImageModel({ imageModel: "gemini:gemini-3.1-flash-image" });

    await client.settings.setImageModel({ imageModel: null });

    await expect(client.settings.get()).resolves.toMatchObject({ imageModel: null });
  });

  it("rejects an id that is not an Image Model", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await expect(client.settings.setImageModel({ imageModel: "openai:nope" })).rejects.toThrow(
      /not an available Image Model/,
    );
  });

  it("rejects a chat-only Model", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");

    await expect(client.settings.setImageModel({ imageModel: "openai:gpt-5.6" })).rejects.toThrow(
      /not an available Image Model/,
    );
  });

  it("rejects a curated Image Model of a Provider the user has no credentials for", async () => {
    const { client } = await signedIn();

    await expect(
      client.settings.setImageModel({ imageModel: "openai:gpt-image-1-mini" }),
    ).rejects.toThrow(/not an available Image Model/);
    await expect(client.settings.get()).resolves.toMatchObject({ imageModel: null });
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
