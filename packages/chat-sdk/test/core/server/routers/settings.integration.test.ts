import { describe, expect, it } from "vitest";

import { instructionsMaxChars } from "../../../../core/shared/chat/instructions";
import { createTestDeps } from "../../../support/deps";
import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

const deps = createTestDeps();

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user, deps }) };
}

describe("settings", () => {
  it("has no Title Model by default (the Model that wrote the first reply)", async () => {
    const { client } = await signedIn();

    await expect(client.settings.get()).resolves.toEqual({ titleModel: null, instructions: null });
  });

  it("saves the Title Model and resets it to the default", async () => {
    const { client } = await signedIn();

    await client.settings.setTitleModel({ titleModel: "openai:gpt-5.4-mini" });
    await expect(client.settings.get()).resolves.toMatchObject({
      titleModel: "openai:gpt-5.4-mini",
    });

    await client.settings.setTitleModel({ titleModel: null });
    await expect(client.settings.get()).resolves.toMatchObject({ titleModel: null });
  });

  it("keeps each user's Title Model to themselves", async () => {
    const { client } = await signedIn();
    const other = await signedIn();

    await client.settings.setTitleModel({ titleModel: "openai:gpt-5.4-mini" });

    await expect(other.client.settings.get()).resolves.toMatchObject({ titleModel: null });
  });

  it("saves a live-listed Title Model (OpenRouter, Ollama)", async () => {
    const { client } = await signedIn();

    await client.settings.setTitleModel({ titleModel: "openrouter:mistralai/mistral-large" });
    await expect(client.settings.get()).resolves.toMatchObject({
      titleModel: "openrouter:mistralai/mistral-large",
    });
  });

  it("rejects a Model that isn't on the list", async () => {
    const { client } = await signedIn();

    await expect(client.settings.setTitleModel({ titleModel: "openai:nope" })).rejects.toThrow(
      /not an available Model/,
    );
  });

  it("saves the Instructions beside the Title Model and reads them back", async () => {
    const { client } = await signedIn();

    await client.settings.setTitleModel({ titleModel: "openai:gpt-5.4-mini" });
    await client.settings.setInstructions({
      instructions: "Answer briefly. Use British spelling.",
    });

    await expect(client.settings.get()).resolves.toEqual({
      titleModel: "openai:gpt-5.4-mini",
      instructions: "Answer briefly. Use British spelling.",
    });
  });

  it("reads blank or whitespace-only Instructions back as null", async () => {
    const { client } = await signedIn();

    await client.settings.setInstructions({ instructions: "   \n\t " });
    await expect(client.settings.get()).resolves.toMatchObject({ instructions: null });

    await client.settings.setInstructions({ instructions: "Be terse." });
    await client.settings.setInstructions({ instructions: null });
    await expect(client.settings.get()).resolves.toMatchObject({ instructions: null });
  });

  it("refuses Instructions over the limit and keeps the saved ones", async () => {
    const { client } = await signedIn();
    await client.settings.setInstructions({ instructions: "Be terse." });

    await expect(
      client.settings.setInstructions({ instructions: "x".repeat(instructionsMaxChars + 1) }),
    ).rejects.toThrow(/4,000 characters/);

    await expect(client.settings.get()).resolves.toMatchObject({ instructions: "Be terse." });
  });

  it("keeps each user's Instructions to themselves", async () => {
    const { client } = await signedIn();
    const other = await signedIn();

    await client.settings.setInstructions({ instructions: "Be terse." });

    await expect(other.client.settings.get()).resolves.toMatchObject({ instructions: null });
  });

  it("rejects signed-out callers", async () => {
    const client = chatRpc({ deps });

    await expect(client.settings.get()).rejects.toThrow();
    await expect(client.settings.setTitleModel({ titleModel: null })).rejects.toThrow();
    await expect(client.settings.setInstructions({ instructions: null })).rejects.toThrow();
  });
});
