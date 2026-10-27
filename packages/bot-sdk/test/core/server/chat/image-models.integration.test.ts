import { describe, expect, it } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { modelSettings } from "@botsdk/bot/storage";
import type { HostProvider } from "@botsdk/bot/models/internal";
import { createTestSdk } from "../../../support/deps";
import { insertUser, type TestUser } from "../../../support/users";
import { getTestDb } from "../../../support/test-database";

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

async function addCredentials(deps: ReturnType<typeof createTestSdk>, user: TestUser) {
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
}

describe("models.resolveUserImageModel", () => {
  it("uses the user's pick on their own credentials over the Host's default", async () => {
    const deps = createTestSdk({
      hostProviders,
      defaultImageModel: "gemini:gemini-3.1-flash-image",
    });
    const user = await insertUser();
    await addCredentials(deps, user);
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: user.id, imageModel: "openai:gpt-image-1-mini" });

    const resolved = await deps.models.resolveUserImageModel(user.id);

    expect(resolved).toMatchObject({
      id: "openai:gpt-image-1-mini",
      meter: expect.objectContaining({ onHost: false }),
      credentials: { apiKey: "openai-test-key" },
    });
    expect(resolved?.hostModel).toBeUndefined();
  });

  it("falls back to the Host's default, pinned and priced, when the user picks none", async () => {
    const deps = createTestSdk({
      hostProviders,
      defaultImageModel: "gemini:gemini-3.1-flash-image",
    });
    const user = await insertUser();

    const resolved = await deps.models.resolveUserImageModel(user.id);

    expect(resolved).toMatchObject({
      id: "gemini:gemini-3.1-flash-image",
      meter: expect.objectContaining({ onHost: true }),
      credentials: { apiKey: "host-gemini-key" },
      hostModel: { size: "1024x1024", quality: "medium", pricePerImageUsd: 0.04 },
    });
  });

  it("resolves to none with no pick and no Host default", async () => {
    const deps = createTestSdk({ hostProviders });
    const user = await insertUser();

    await expect(deps.models.resolveUserImageModel(user.id)).resolves.toBeNull();
  });

  it("resolves to none, not the Host's default, when the user's pick has lost its credentials", async () => {
    const deps = createTestSdk({
      hostProviders,
      defaultImageModel: "gemini:gemini-3.1-flash-image",
    });
    const user = await insertUser();
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: user.id, imageModel: "openai:gpt-image-1-mini" });

    await expect(deps.models.resolveUserImageModel(user.id)).resolves.toBeNull();
  });

  it("ignores the user's own credentials when byok is off", async () => {
    const deps = createTestSdk({
      hostProviders,
      defaultImageModel: "gemini:gemini-3.1-flash-image",
      byok: false,
    });
    const user = await insertUser();
    await addCredentials(deps, user);
    await getTestDb()
      .insert(modelSettings)
      .values({ userId: user.id, imageModel: "openai:gpt-image-1-mini" });

    await expect(deps.models.resolveUserImageModel(user.id)).resolves.toBeNull();
  });
});
