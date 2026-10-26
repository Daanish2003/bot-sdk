import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../plugins/models/server/internal";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { insertUser } from "../../support/users";

const model = "openai:gpt-6-luna";

/** A user with an OpenAI key, so `model` is one of their Models, and their HTTP client. */
async function aUser(deps: ReturnType<typeof createTestSdk>) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { userId: user.id, client: chatRpc({ user, deps }) };
}

describe("sdk.secrets, called in-process with a userId (#897)", () => {
  it("saves, lists and deletes as the HTTP twins do, and never returns a value", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });

    await deps.secrets.save({ userId, botId, name: "B_TOKEN", value: "twos" });
    await client.bot.secret.save({ botId, name: "A_TOKEN", value: "ones" });

    const listed = await deps.secrets.list({ userId });
    expect(listed).toEqual([
      { name: "A_TOKEN", createdAt: expect.any(Date) },
      { name: "B_TOKEN", createdAt: expect.any(Date) },
    ]);
    expect(listed).toEqual(await client.bot.secret.list());
    expect(JSON.stringify(listed)).not.toMatch(/ones|twos/);

    await deps.secrets.delete({ userId, name: "A_TOKEN" });
    expect((await client.bot.secret.list()).map((secret) => secret.name)).toEqual(["B_TOKEN"]);
  }, 30_000);

  it("refuses another user's Bot and shows another user no Secrets", async () => {
    const deps = createTestSdk();
    const owner = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId: owner.userId, name: "Ada", model });
    await deps.secrets.save({ userId: owner.userId, botId, name: "A_TOKEN", value: "ones" });
    const { userId } = await aUser(deps);

    await expect(
      deps.secrets.save({ userId, botId, name: "A_TOKEN", value: "twos" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await deps.secrets.list({ userId })).toEqual([]);
    await deps.secrets.delete({ userId, name: "A_TOKEN" });
    expect(await deps.secrets.list({ userId: owner.userId })).toHaveLength(1);
  }, 30_000);

  it("refuses a name that is not an environment variable name, as HTTP does", async () => {
    const deps = createTestSdk();
    const { userId } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });

    await expect(
      deps.secrets.save({ userId, botId, name: "not a name", value: "ones" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 30_000);
});

describe("sdk.models, called in-process with a userId (#897)", () => {
  const goodKey = "sk-ant-api03-secret-good-1234";
  const answering = (status: number) =>
    (async () => new Response("{}", { status })) as unknown as typeof globalThis.fetch;

  it("saves, lists and deletes credentials as the HTTP twins do, showing only a hint", async () => {
    const deps = createTestSdk({ fetch: answering(200) });
    const user = await insertUser();
    const client = chatRpc({ user, deps });
    const userId = user.id;

    const saved = await deps.models.credentials.save({
      userId,
      service: "anthropic",
      fields: { apiKey: goodKey },
    });

    expect(saved).toEqual({ service: "anthropic", hint: "…1234", verified: true });
    const listed = await deps.models.credentials.list({ userId });
    expect(listed).toEqual([{ service: "anthropic", hint: "…1234", verified: true }]);
    expect(listed).toEqual(await client.credentials.list());
    expect(await deps.models.credentials.openaiState({ userId })).toEqual(
      await client.credentials.openaiState(),
    );
    expect((await deps.models.list({ userId })).models.length).toBeGreaterThan(0);
    expect(await deps.models.list({ userId })).toEqual(await client.models.list());

    await deps.models.credentials.delete({ userId, service: "anthropic" });
    expect(await client.credentials.list()).toEqual([]);
  }, 30_000);

  it("rejects bad credentials and keeps one user's credentials from another", async () => {
    const deps = createTestSdk({ fetch: answering(401) });
    const owner = await insertUser();
    const other = await insertUser();
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: goodKey },
      hint: "…1234",
      verified: true,
    });

    await expect(
      deps.models.credentials.save({
        userId: other.id,
        service: "anthropic",
        fields: { apiKey: goodKey },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await deps.models.credentials.list({ userId: other.id })).toEqual([]);
    expect(await deps.models.credentials.list({ userId: owner.id })).toHaveLength(1);
  }, 30_000);

  it("reads and sets the Image Model, refusing one the user can't use", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);

    expect(await deps.models.imageModel({ userId })).toEqual({ imageModel: null });
    await expect(
      deps.models.setImageModel({ userId, imageModel: "nobody:nothing" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await deps.models.setImageModel({ userId, imageModel: null });
    expect(await client.models.imageModel()).toEqual({ imageModel: null });
  }, 30_000);
});
