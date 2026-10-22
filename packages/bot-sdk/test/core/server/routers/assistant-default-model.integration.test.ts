import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { createTestSdk, chatRpc } from "../../../support/assistant";
import { insertConversation } from "../../../support/conversations";
import { insertUser, type TestUser } from "../../../support/users";

const deps = createTestSdk();

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

/** The assistant's recent-Model source: `models.list` defaults to its newest Conversation's Model. */
describe("models.list default with the assistant", () => {
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

  it("passes over a newer Conversation that has no Model, such as a Bot's", async () => {
    const { user, client } = await signedIn();
    await addCredentials(user, "openai");
    await addCredentials(user, "anthropic");
    await insertConversation(user, {
      model: "anthropic:claude-opus-5-5",
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    });
    await insertConversation(user, {
      kind: "bot",
      model: null,
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
});
