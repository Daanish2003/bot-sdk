import { describe, expect, it } from "vitest";

import { en } from "../../../../core/shared/i18n";
import { createTestSdk } from "../../../support/deps";
import { chatRpc } from "../../../support/sdk";
import { insertUser } from "../../../support/users";

/** The `data` an oRPC error carries, through `chat.handler`, with its code checked against the dictionary. */
async function dataOf(call: Promise<unknown>) {
  const error = await call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (caught: unknown) => caught as { data?: { code?: string; params?: unknown } },
  );
  expect(error.data?.code).toBeTypeOf("string");
  expect(en).toHaveProperty([error.data?.code ?? ""]);
  return error.data;
}

const missingId = "018f0000-0000-7000-8000-000000000000";

describe("oRPC errors through chat.handler", () => {
  it("sends the code for a Conversation that isn't there", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(dataOf(client.conversation.get({ id: missingId }))).resolves.toEqual({
      code: "error.conversationNotFound",
    });
  });

  it("sends the code and the Model for a Model that isn't available", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(dataOf(client.conversation.create({ model: "openai:gpt-2" }))).resolves.toEqual({
      code: "error.modelNotAvailable",
      params: { model: "openai:gpt-2" },
    });
  });

  it("sends the code for an invalid cursor", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(dataOf(client.conversation.list({ cursor: "not-a-cursor" }))).resolves.toEqual({
      code: "error.invalidCursor",
    });
  });

  it("sends the limit as a number param for Instructions that are too long", async () => {
    const client = chatRpc({ user: await insertUser() });
    const { id } = await client.project.create({ name: "Thesis" });

    await expect(
      dataOf(client.project.update({ id, name: "Thesis", instructions: "x".repeat(4_001) })),
    ).resolves.toEqual({ code: "error.instructionsTooLong", params: { max: 4_000 } });
  });

  it("sends the code for a Shared link that isn't there", async () => {
    const client = chatRpc({ user: null });

    await expect(dataOf(client.share.get({ token: "missing-token" }))).resolves.toEqual({
      code: "error.sharedLinkNotFound",
    });
  });

  it("sends the code for a Message that isn't there", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(
      dataOf(client.chat.decide({ messageId: missingId, approved: true })),
    ).resolves.toEqual({ code: "error.messageNotFound" });
  });

  it("sends the code for credentials when the Host has turned the user's own keys off", async () => {
    const user = await insertUser();
    const client = chatRpc({ user, deps: createTestSdk({ byok: false }) });

    await expect(
      dataOf(client.credentials.save({ service: "openai", fields: { apiKey: "sk-test" } })),
    ).resolves.toEqual({ code: "error.byokOff" });
  });
});
