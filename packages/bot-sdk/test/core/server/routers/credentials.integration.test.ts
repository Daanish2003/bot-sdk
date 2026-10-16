import { describe, expect, it } from "vitest";

import { loadCredentials, saveCredentials } from "../../../../core/server/credentials/store";
import { createTestDeps } from "../../../support/deps";
import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

const goodKey = "sk-ant-api03-secret-good-1234";

/** A `deps.fetch` that answers every check with `status` and records the URLs it was called with. */
function providerAnswering(status: number) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("{}", { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

async function signedIn(status = 200) {
  const user = await insertUser();
  const provider = providerAnswering(status);
  const deps = createTestDeps({ fetch: provider.fetch });
  return { user, deps, provider, client: chatRpc({ user, deps }) };
}

describe("credentials", () => {
  it("lists nothing for a user without credentials", async () => {
    const { client } = await signedIn();

    await expect(client.credentials.list()).resolves.toEqual([]);
  });

  it("checks and saves Anthropic credentials, showing only a hint", async () => {
    const { client, provider, user, deps } = await signedIn(200);

    const saved = await client.credentials.save({
      service: "anthropic",
      fields: { apiKey: goodKey },
    });

    expect(saved).toEqual({ service: "anthropic", hint: "…1234", verified: true });
    expect(provider.urls).toEqual(["https://api.anthropic.com/v1/models?limit=1"]);
    expect(await client.credentials.list()).toEqual([
      { service: "anthropic", hint: "…1234", verified: true },
    ]);
    await expect(loadCredentials(deps, user.id, "anthropic")).resolves.toEqual({
      apiKey: goodKey,
    });
  });

  it("checks and saves OpenAI credentials", async () => {
    const { client, provider } = await signedIn(200);

    await client.credentials.save({ service: "openai", fields: { apiKey: "sk-proj-abcd" } });

    expect(provider.urls).toEqual(["https://api.openai.com/v1/models"]);
    expect(await client.credentials.list()).toEqual([
      { service: "openai", hint: "…abcd", verified: true },
    ]);
  });

  it("never gives the client a secret back", async () => {
    const { client, deps } = await signedIn(200);

    const saved = await client.credentials.save({
      service: "anthropic",
      fields: { apiKey: goodKey },
    });
    const listed = await client.credentials.list();
    const [row] = await deps.db.query.userCredentials.findMany();

    expect(JSON.stringify([saved, listed])).not.toContain("secret-good");
    expect(row?.encrypted).not.toContain("secret-good");
  });

  it("replaces credentials for the same Provider", async () => {
    const { client, user, deps } = await signedIn(200);
    await client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } });

    await client.credentials.save({ service: "anthropic", fields: { apiKey: "sk-ant-new-9876" } });

    expect(await client.credentials.list()).toEqual([
      { service: "anthropic", hint: "…9876", verified: true },
    ]);
    await expect(loadCredentials(deps, user.id, "anthropic")).resolves.toEqual({
      apiKey: "sk-ant-new-9876",
    });
  });

  it("deletes credentials", async () => {
    const { client, user, deps } = await signedIn(200);
    await client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } });
    await client.credentials.save({ service: "openai", fields: { apiKey: "sk-proj-abcd" } });

    await client.credentials.delete({ service: "anthropic" });

    expect(await client.credentials.list()).toEqual([
      { service: "openai", hint: "…abcd", verified: true },
    ]);
    await expect(loadCredentials(deps, user.id, "anthropic")).resolves.toBeNull();
  });

  it("refuses a key the Provider rejects and saves nothing", async () => {
    const { client } = await signedIn(401);

    await expect(
      client.credentials.save({ service: "anthropic", fields: { apiKey: "sk-ant-typo" } }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Anthropic rejected this API key.",
      data: { reason: "invalid_key" },
    });
    await expect(client.credentials.list()).resolves.toEqual([]);
  });

  it("keeps the saved credentials when a replacement is rejected", async () => {
    const user = await insertUser();
    const accepting = chatRpc({
      user,
      deps: createTestDeps({ fetch: providerAnswering(200).fetch }),
    });
    const rejecting = chatRpc({
      user,
      deps: createTestDeps({ fetch: providerAnswering(401).fetch }),
    });
    await accepting.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } });

    await expect(
      rejecting.credentials.save({ service: "anthropic", fields: { apiKey: "sk-ant-typo" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await accepting.credentials.list()).toEqual([
      { service: "anthropic", hint: "…1234", verified: true },
    ]);
  });

  it("refuses an empty key without calling the Provider", async () => {
    const { client, provider } = await signedIn(200);

    await expect(
      client.credentials.save({ service: "anthropic", fields: { apiKey: "  " } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provider.urls).toEqual([]);
  });

  it("refuses a service that isn't a Provider or Tool", async () => {
    const { client, provider } = await signedIn(200);

    await expect(
      // @ts-expect-error not a credential service
      client.credentials.save({ service: "acme", fields: { apiKey: "acme-key" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provider.urls).toEqual([]);
  });

  it("saves Bedrock credentials as not verified, without a check", async () => {
    const { client, provider, user, deps } = await signedIn(200);

    const saved = await client.credentials.save({
      service: "bedrock",
      fields: { apiKey: "ABSK-bedrock-key-wxyz", region: "us-west-2" },
    });

    expect(saved).toEqual({ service: "bedrock", hint: "…wxyz", verified: false });
    expect(provider.urls).toEqual([]);
    expect(await client.credentials.list()).toEqual([
      { service: "bedrock", hint: "…wxyz", verified: false },
    ]);
    await expect(loadCredentials(deps, user.id, "bedrock")).resolves.toEqual({
      apiKey: "ABSK-bedrock-key-wxyz",
      region: "us-west-2",
    });
  });

  it("checks and saves Cloudflare credentials with the account id", async () => {
    const { client, provider, user, deps } = await signedIn(200);

    await client.credentials.save({
      service: "cloudflare",
      fields: { accountId: "acc123", apiKey: "cf-token-9876" },
    });

    expect(provider.urls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/models/search?per_page=1",
    ]);
    expect(await client.credentials.list()).toEqual([
      { service: "cloudflare", hint: "…9876", verified: true },
    ]);
    await expect(loadCredentials(deps, user.id, "cloudflare")).resolves.toEqual({
      accountId: "acc123",
      apiKey: "cf-token-9876",
    });
  });

  it("checks that the Ollama host is reachable and shows the host as the hint", async () => {
    const { client, provider } = await signedIn(200);

    const saved = await client.credentials.save({
      service: "ollama",
      fields: { host: "http://host.docker.internal:11434/" },
    });

    expect(saved).toEqual({
      service: "ollama",
      hint: "http://host.docker.internal:11434",
      verified: true,
    });
    expect(provider.urls).toEqual(["http://host.docker.internal:11434/api/tags"]);
  });

  it("treats credentials that no longer decrypt as missing", async () => {
    const { client, user } = await signedIn(200);
    await client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } });
    const rotated = createTestDeps({
      keyEncryptionSecrets: ["a-different-secret-of-32-characters!"],
    });

    await expect(chatRpc({ user, deps: rotated }).credentials.list()).resolves.toEqual([]);
    await expect(loadCredentials(rotated, user.id, "anthropic")).resolves.toBeNull();
  });

  it("keeps each user's credentials invisible to other users", async () => {
    const owner = await signedIn(200);
    await owner.client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } });
    const other = await signedIn(200);

    await expect(other.client.credentials.list()).resolves.toEqual([]);
    await other.client.credentials.delete({ service: "anthropic" });

    expect(await owner.client.credentials.list()).toEqual([
      { service: "anthropic", hint: "…1234", verified: true },
    ]);
    await expect(loadCredentials(owner.deps, other.user.id, "anthropic")).resolves.toBeNull();
  });

  it("rejects signed-out callers", async () => {
    const client = chatRpc();

    await expect(client.credentials.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.credentials.delete({ service: "anthropic" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("credentials with byok off (ADR 0007)", () => {
  async function byokOff() {
    const user = await insertUser();
    const provider = providerAnswering(200);
    const deps = createTestDeps({ fetch: provider.fetch, byok: false });
    await saveCredentials(deps, user.id, {
      service: "openai",
      hint: "…abcd",
      verified: true,
      fields: { apiKey: "sk-proj-abcd" },
    });
    return { user, deps, provider, client: chatRpc({ user, deps }) };
  }

  it("rejects saving a key without checking it with the Provider", async () => {
    const { client, provider, deps, user } = await byokOff();

    await expect(
      client.credentials.save({ service: "anthropic", fields: { apiKey: goodKey } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.urls).toEqual([]);
    await expect(loadCredentials(deps, user.id, "anthropic")).resolves.toBeNull();
  });

  it("still lists and deletes the credentials it already holds", async () => {
    const { client, deps, user } = await byokOff();

    await expect(client.credentials.list()).resolves.toEqual([
      { service: "openai", hint: "…abcd", verified: true },
    ]);
    await client.credentials.delete({ service: "openai" });

    expect(await client.credentials.list()).toEqual([]);
    await expect(loadCredentials(deps, user.id, "openai")).resolves.toBeNull();
  });

  it("tells the client the mode", async () => {
    const { client } = await byokOff();

    await expect(client.credentials.mode()).resolves.toEqual({ byok: false });
  });
});
