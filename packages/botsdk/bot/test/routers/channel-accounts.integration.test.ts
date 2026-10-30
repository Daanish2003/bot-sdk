import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryPubSub, type PubSub } from "../../src/chat/pubsub";
import { emailChannel } from "../../src/channel";
import { createBotSdk } from "../../src/create-chat";
import { postgres } from "../../src/database";
import { saveCredentials } from "../../src/models/internal";
import type { BotSdkPlugin } from "../../src/plugin";
import { channelAccount } from "../../src/storage";
import { deleteUserData } from "../../src/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeEmailProvider, fakeMessagingAdapter } from "@botsdk/testing/fake-channel";

/*
 * The messaging Channel seam (spec #1044, ticket #1045): Channel accounts saved, fixed and removed
 * through the `channels.accounts` RPCs, and their listeners, over the fake messaging adapter.
 */

const timeout = { timeout: 30_000 };
const poll = { timeout: 10_000 };
const model = "openai:gpt-6-luna";
const keyA = "key-a-of-at-least-32-characters-long!!";
const keyB = "key-b-of-at-least-32-characters-long!!";

/** The channel parts started by a test, stopped after it. */
const started: { part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { part, deps } of started.splice(0)) await part.stop!(deps);
});

/** The `channel` part of `deps`, which runs the listeners. */
const channelPart = (deps: TestDeps) => deps.parts.all.find((part) => part.id === "channel")!;

/** Starts the listeners of `deps`, as `sdk.start()` does, and stops them after the test. */
async function startListeners(deps: TestDeps) {
  const part = channelPart(deps);
  await part.start!(deps);
  started.push({ part, deps });
}

/** An instance with the fake messaging adapter (and `pubsub`, to share it with another instance). */
function messagingSdk(
  fake = fakeMessagingAdapter(),
  { pubsub, keyring }: { pubsub?: PubSub; keyring?: string[] } = {},
) {
  const deps = createTestSdk({
    channels: [fake.adapter],
    ...(pubsub && { pubsub }),
    ...(keyring && { keyEncryptionSecrets: keyring }),
  });
  return { deps, fake };
}

/** A user with a usable Model, a Bot of theirs, and their client. */
async function aBot(deps: TestDeps, name = "Ada") {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const { id: botId } = await deps.bots.create({ userId: user.id, name, model });
  return { user, botId, client: chatRpc({ user, deps }) };
}

const accountRow = async (botId: string) =>
  (await getTestDb().select().from(channelAccount).where(eq(channelAccount.botId, botId)))[0];

describe("channels.accounts", () => {
  it(
    "lists the Host's messaging platforms, and saves an account once the platform accepts it",
    timeout,
    async () => {
      const { deps } = messagingSdk();
      const { client, botId } = await aBot(deps);

      expect(await client.channels.accounts.list({ botId })).toEqual([
        { platform: "fake", fields: ["token"], account: null },
      ]);
      const saved = await client.channels.accounts.save({
        botId,
        platform: "fake",
        credentials: { token: "123:secret-token" },
      });

      expect(saved).toMatchObject({
        platform: "fake",
        fields: ["token"],
        account: { handle: "@bot_123", status: "active", reason: null },
      });
      expect(JSON.stringify(saved)).not.toContain("secret-token");
      expect(await client.channels.accounts.list({ botId })).toEqual([saved]);
      // Stored encrypted, never as the plaintext.
      const row = await accountRow(botId);
      expect(row).toMatchObject({ platform: "fake", platformBotId: "123", status: "active" });
      expect(row!.encrypted).toMatch(/^v2\./);
      expect(row!.encrypted).not.toContain("secret-token");
    },
  );

  it("refuses credentials the platform rejects, and saves nothing", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const { client, botId } = await aBot(deps);
    fake.rejected.add("123:revoked");

    const tries: Record<string, string>[] = [{ token: "123:revoked" }, { other: "123:fine" }];
    for (const credentials of tries) {
      await expect(
        client.channels.accounts.save({ botId, platform: "fake", credentials }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { code: "error.channelCredentialsRejected" },
      });
    }
    expect(await accountRow(botId)).toBeUndefined();
  });

  it("fixes an account in place with new credentials", timeout, async () => {
    const { deps } = messagingSdk();
    const { client, botId } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });
    const before = await accountRow(botId);

    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "2:b" } });

    const after = await accountRow(botId);
    expect(after).toMatchObject({ id: before!.id, platformBotId: "2", handle: "@bot_2" });
    expect(after!.encrypted).not.toBe(before!.encrypted);
  });

  it(
    "moves a platform bot from another of the user's Bots, and refuses one on someone else's",
    timeout,
    async () => {
      const { deps } = messagingSdk();
      const ada = await aBot(deps, "Ada");
      const credentials = { token: "77:shared" };
      await ada.client.channels.accounts.save({ botId: ada.botId, platform: "fake", credentials });
      const { id: grace } = await deps.bots.create({ userId: ada.user.id, name: "Grace", model });

      await ada.client.channels.accounts.save({ botId: grace, platform: "fake", credentials });

      expect(await accountRow(ada.botId)).toBeUndefined();
      expect(await accountRow(grace)).toMatchObject({ platformBotId: "77" });
      const stranger = await aBot(deps, "Eve");
      await expect(
        stranger.client.channels.accounts.save({
          botId: stranger.botId,
          platform: "fake",
          credentials,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.channelAccountTaken" } });
      expect(await accountRow(grace)).toMatchObject({ platformBotId: "77" });
    },
  );

  it("refuses another user's Bot and an unknown platform", timeout, async () => {
    const { deps } = messagingSdk();
    const ada = await aBot(deps);
    const eve = await aBot(deps, "Eve");

    await expect(eve.client.channels.accounts.list({ botId: ada.botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { code: "error.botNotFound" },
    });
    await expect(
      ada.client.channels.accounts.save({
        botId: ada.botId,
        platform: "telegram",
        credentials: { token: "1:a" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { code: "error.channelPlatformNotFound" } });
  });

  it("removes an account", timeout, async () => {
    const { deps } = messagingSdk();
    const { client, botId } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });

    await client.channels.accounts.remove({ botId, platform: "fake" });

    expect(await client.channels.accounts.list({ botId })).toEqual([
      { platform: "fake", fields: ["token"], account: null },
    ]);
  });

  it("isn't served without a messaging adapter", timeout, async () => {
    const deps = createTestSdk({
      channels: [
        emailChannel({
          provider: fakeEmailProvider().provider,
          domain: "bots.example",
          appUrl: "https://app.example",
        }),
      ],
    });
    const { client, botId } = await aBot(deps);

    await expect(client.channels.accounts.list({ botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { code: "error.channelPlatformNotFound" },
    });
  });
});

describe("the Channel accounts' listeners", () => {
  it(
    "start one per active account with the SDK, follow saves, fixes and removes, and stop with it",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "Ada");
      const grace = await aBot(deps, "Grace");
      await ada.client.channels.accounts.save({
        botId: ada.botId,
        platform: "fake",
        credentials: { token: "1:a" },
      });

      await startListeners(deps);
      expect([...fake.listening.keys()]).toEqual(["@bot_1"]);

      // A save while the SDK runs starts its listener, a fix restarts it on the new credentials.
      await grace.client.channels.accounts.save({
        botId: grace.botId,
        platform: "fake",
        credentials: { token: "2:b" },
      });
      await expect
        .poll(() => [...fake.listening.keys()].sort(), poll)
        .toEqual(["@bot_1", "@bot_2"]);
      await grace.client.channels.accounts.save({
        botId: grace.botId,
        platform: "fake",
        credentials: { token: "3:c" },
      });
      await expect
        .poll(() => fake.listening.get("@bot_3")?.account.credentials.token, poll)
        .toBe("3:c");
      expect(fake.listening.has("@bot_2")).toBe(false);

      // An update goes to the core's entry point, which takes it.
      await fake.deliver("@bot_1", { text: "hello" });

      await ada.client.channels.accounts.remove({ botId: ada.botId, platform: "fake" });
      await expect.poll(() => [...fake.listening.keys()], poll).toEqual(["@bot_3"]);

      await started.splice(0)[0]!.part.stop!(deps);
      expect(fake.listening.size).toBe(0);
    },
  );

  it(
    "stop on a credentials rejection, mark the account, and don't retry until it is fixed",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const { client, botId } = await aBot(deps);
      await client.channels.accounts.save({
        botId,
        platform: "fake",
        credentials: { token: "1:a" },
      });
      await startListeners(deps);
      expect(fake.listening.has("@bot_1")).toBe(true);

      fake.revoke("1:a");

      await expect
        .poll(async () => (await client.channels.accounts.list({ botId }))[0]?.account, poll)
        .toMatchObject({ status: "needs_attention", reason: "Unauthorized" });
      const listens = fake.counts.listens;
      expect(fake.listening.size).toBe(0);
      // A sync finds nothing to listen to.
      await channelPart(deps).stop!(deps);
      await channelPart(deps).start!(deps);
      expect(fake.counts.listens).toBe(listens);

      await client.channels.accounts.save({
        botId,
        platform: "fake",
        credentials: { token: "1:fixed" },
      });
      await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
      expect((await client.channels.accounts.list({ botId }))[0]?.account).toMatchObject({
        status: "active",
        reason: null,
      });
    },
  );

  it(
    "listen to an account saved after the SDK started, and stop it with the SDK",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const part = channelPart(deps);
      await part.start!(deps);
      started.push({ part, deps });
      // Building the RPC client composes the instance again, as a Host's own code may.
      const { client, botId } = await aBot(deps);

      await client.channels.accounts.save({
        botId,
        platform: "fake",
        credentials: { token: "1:a" },
      });
      await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
      await started.splice(0)[0]!.part.stop!(deps);

      expect(fake.listening.size).toBe(0);
    },
  );

  it("back off and retry on a network error", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const { client, botId } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });
    fake.counts.failures = 1;

    await startListeners(deps);

    expect(fake.listening.size).toBe(0);
    await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
    expect(fake.counts.listens).toBe(2);
    expect((await client.channels.accounts.list({ botId }))[0]?.account?.status).toBe("active");
  });

  it(
    "run once between two instances over one database, and move when the holder stops",
    timeout,
    async () => {
      const pubsub = createMemoryPubSub();
      const first = messagingSdk(fakeMessagingAdapter(), { pubsub });
      const second = messagingSdk(fakeMessagingAdapter(), { pubsub });
      const { client, botId } = await aBot(first.deps);
      await client.channels.accounts.save({
        botId,
        platform: "fake",
        credentials: { token: "1:a" },
      });

      await startListeners(first.deps);
      await startListeners(second.deps);

      expect(first.fake.listening.has("@bot_1")).toBe(true);
      expect(second.fake.listening.size).toBe(0);
      await started.splice(0, 1)[0]!.part.stop!(first.deps);
      await expect.poll(() => second.fake.listening.has("@bot_1"), poll).toBe(true);
      expect(first.fake.listening.size).toBe(0);
    },
  );

  it("stop when the Bot is deleted, and keep running through a Bot reset", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const { user, client, botId } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });
    await startListeners(deps);

    await client.bots.reset({ botId, name: "Ada" });

    expect(await accountRow(botId)).toMatchObject({ status: "active" });
    expect(fake.listening.has("@bot_1")).toBe(true);

    await deleteUserData(deps, user.id);

    expect(await accountRow(botId)).toBeUndefined();
    await expect.poll(() => fake.listening.size, poll).toBe(0);
  });
});

describe("rotateKeys", () => {
  it("re-encrypts the Channel accounts' credentials under the new key", timeout, async () => {
    const { deps, fake } = messagingSdk(fakeMessagingAdapter(), { keyring: [keyA] });
    const { client, botId } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });
    const before = await accountRow(botId);
    const rotating = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [keyB, keyA],
      logger: { error: () => {} },
      models: {},
      channels: [fake.adapter],
    });

    const result = await rotating.rotateKeys();

    expect(result.reencrypted).toBeGreaterThanOrEqual(1);
    expect((await accountRow(botId))!.encrypted).not.toBe(before!.encrypted);
    await rotating.stop();
    // Only the new key reads it now: its listener starts on the credentials.
    const onlyNew = messagingSdk(fake, { keyring: [keyB] });
    await startListeners(onlyNew.deps);
    expect(fake.listening.get("@bot_1")?.account.credentials).toEqual({ token: "1:a" });
  });

  it("marks an account whose credentials no key reads as needing attention", timeout, async () => {
    const { deps, fake } = messagingSdk(fakeMessagingAdapter(), { keyring: [keyA] });
    const { botId, client } = await aBot(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });

    const keyless = messagingSdk(fake, { keyring: [keyB] });
    await startListeners(keyless.deps);

    expect(fake.listening.size).toBe(0);
    expect(await accountRow(botId)).toMatchObject({
      status: "needs_attention",
      reason: "The saved credentials can't be read",
    });
  });
});
