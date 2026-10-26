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

describe("oRPC errors through chat.handler, on a Bot-only SDK", () => {
  it("sends the code for a Bot that isn't there", async () => {
    const client = chatRpc({ user: await insertUser(), deps: createTestSdk() });

    await expect(dataOf(client.bot.get({ botId: missingId }))).resolves.toEqual({
      code: "error.botNotFound",
    });
  });

  it("sends the code and the Model for a Model that isn't available", async () => {
    const client = chatRpc({ user: await insertUser(), deps: createTestSdk() });

    await expect(
      dataOf(client.bot.create({ name: "Ada", model: "openai:gpt-2" })),
    ).resolves.toEqual({ code: "error.modelNotAvailable", params: { model: "openai:gpt-2" } });
  });

  it("sends the code for credentials when the Host has turned the user's own keys off", async () => {
    const user = await insertUser();
    const client = chatRpc({ user, deps: createTestSdk({ byok: false }) });

    await expect(
      dataOf(client.credentials.save({ service: "openai", fields: { apiKey: "sk-test" } })),
    ).resolves.toEqual({ code: "error.byokOff" });
  });
});
