import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotSdk } from "@botsdk/bot/create-chat";
import { encryptCredentials } from "@botsdk/bot/credentials/encryption";
import { postgres } from "@botsdk/bot/database";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { BotSdkPlugin } from "@botsdk/bot/plugin";
import { channelAccount, type Database } from "@botsdk/bot/storage";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { connectChannelAccount, listChannelAccounts } from "../src/server/channel-accounts";
import { representative, representativeChannelAccount } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";

/*
 * A Channel account held by a Representative (ticket #1331, ADR 0033), over the fake messaging adapter
 * on real Postgres: one holder only, moves between holders in both directions, the keyring, and the
 * listeners. There's no owner UI until SMS (#1174), so this goes through the feature's server code.
 */

vi.setConfig({ testTimeout: 30_000 });

const poll = { timeout: 10_000 };
const model = "openai:gpt-6-luna";
const keyA = "key-a-of-at-least-32-characters-long!!";
const keyB = "key-b-of-at-least-32-characters-long!!";

/** The channel parts started by a test, stopped after it. */
const started: { part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { part, deps } of started.splice(0)) await part.stop!(deps);
});

function sdkWith(fake = fakeMessagingAdapter(), keyring = [keyA]) {
  const deps = createTestSdk({
    channels: [fake.adapter],
    features: [representativeFeature()],
    keyEncryptionSecrets: keyring,
  });
  const part = deps.parts.all.find((one) => one.id === "channel")!;
  return {
    deps,
    fake,
    context: deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    startListeners: async () => {
      await part.start!(deps);
      started.push({ part, deps });
    },
  };
}

type Context = ReturnType<typeof sdkWith>["context"];

/** A user with a Representative and a Bot, and their client. */
async function anOwner(deps: TestDeps) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: representativeId } = await client.representative.create({ name: "Front desk" });
  const { id: botId } = await deps.bots.create({ userId: user.id, name: "Ada", model });
  return { user, client, representativeId, botId };
}

/** Inserts an account row as it stands in the database, with no holder unless `botId` is given. */
async function insertAccount(tx: Pick<Database, "insert">, botId?: string) {
  const id = uuidv7();
  const now = new Date();
  await tx.insert(channelAccount).values({
    id,
    botId: botId ?? null,
    platform: "fake",
    platformBotId: id,
    handle: "@raw",
    encrypted: encryptCredentials(
      { token: "1:a" },
      { secrets: [keyA], kind: "channel", context: `${botId ?? id}:fake` },
    ),
    status: "active",
    reason: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const refused = { cause: { code: "23514", constraint: "channel_account_one_holder" } };

describe("an account's holder", () => {
  it("refuses an account with no holder", async () => {
    await expect(insertAccount(getTestDb())).rejects.toMatchObject(refused);
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("refuses an account with both a Bot and a Representative", async () => {
    const { deps } = sdkWith();
    const { representativeId, botId } = await anOwner(deps);

    await expect(
      getTestDb().transaction(async (tx) => {
        const channelAccountId = await insertAccount(tx, botId);
        await tx
          .insert(representativeChannelAccount)
          .values({ channelAccountId, representativeId });
      }),
    ).rejects.toMatchObject(refused);
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("refuses taking the Representative off an account, and giving it a Bot beside it", async () => {
    const { deps } = sdkWith();
    const { representativeId, botId } = await anOwner(deps);
    const channelAccountId = await getTestDb().transaction(async (tx) => {
      const id = await insertAccount(tx);
      await tx
        .insert(representativeChannelAccount)
        .values({ channelAccountId: id, representativeId });
      return id;
    });

    await expect(
      getTestDb()
        .delete(representativeChannelAccount)
        .where(eq(representativeChannelAccount.channelAccountId, channelAccountId)),
    ).rejects.toMatchObject(refused);
    await expect(
      getTestDb()
        .update(channelAccount)
        .set({ botId })
        .where(eq(channelAccount.id, channelAccountId)),
    ).rejects.toMatchObject(refused);
  });

  it("fails a save whose feature records no holder", async () => {
    const { deps, context } = sdkWith();
    const { user } = await anOwner(deps);

    await expect(
      context.channelAccounts.save({
        userId: user.id,
        platform: "fake",
        credentials: { token: "1:a" },
        lock: async () => {},
        hold: async () => {},
      }),
    ).rejects.toMatchObject(refused);
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });
});

describe("connecting an account to a Representative", () => {
  const connect = (context: Context, userId: string, representativeId: string, token: string) =>
    connectChannelAccount(context, {
      userId,
      representativeId,
      platform: "fake",
      credentials: { token },
    });

  it("saves it under the Representative, encrypted, and reads its credentials back", async () => {
    const { deps, fake, context, startListeners } = sdkWith();
    const { user, representativeId } = await anOwner(deps);
    await startListeners();

    const saved = await connect(context, user.id, representativeId, "1:secret-token");

    expect(saved).toMatchObject({
      platform: "fake",
      account: { handle: "@bot_1", status: "active", reason: null },
    });
    const [row] = await getTestDb().select().from(channelAccount);
    expect(row).toMatchObject({ botId: null, platformBotId: "1" });
    expect(row!.encrypted).toMatch(/^v2\./);
    expect(row!.encrypted).not.toContain("secret-token");
    expect(JSON.stringify(saved)).not.toContain("secret-token");
    await expect
      .poll(() => fake.listening.get("@bot_1")?.account.credentials, poll)
      .toEqual({ token: "1:secret-token" });
    expect(fake.listening.get("@bot_1")?.account.botId).toBeNull();
  });

  it("refuses another user's Representative, and credentials the platform rejects", async () => {
    const { deps, fake, context } = sdkWith();
    const { user, representativeId } = await anOwner(deps);
    const other = await insertUser();
    fake.rejected.add("9:revoked");

    await expect(connect(context, other.id, representativeId, "1:a")).rejects.toMatchObject({
      data: { code: "error.representativeNotFound" },
    });
    await expect(connect(context, user.id, representativeId, "9:revoked")).rejects.toMatchObject({
      data: { code: "error.channelCredentialsRejected" },
    });
    await expect(
      connect(context, user.id, representativeId, "1:" + "a".repeat(5000)),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("re-encrypts a held account's credentials under a new key", async () => {
    const { deps, fake, context } = sdkWith(fakeMessagingAdapter(), [keyA]);
    const { user, representativeId } = await anOwner(deps);
    await connect(context, user.id, representativeId, "1:a");
    const [before] = await getTestDb().select().from(channelAccount);
    const rotating = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: [keyB, keyA],
      logger: { error: () => {} },
      models: {},
      channels: [fake.adapter],
    });

    const result = await rotating.rotateKeys();
    await rotating.stop();

    expect(result.reencrypted).toBeGreaterThanOrEqual(1);
    const [after] = await getTestDb().select().from(channelAccount);
    expect(after!.encrypted).not.toBe(before!.encrypted);
    // Only the new key reads it now: its listener starts on the credentials.
    const onlyNew = sdkWith(fake, [keyB]);
    await onlyNew.startListeners();
    expect(fake.listening.get("@bot_1")?.account.credentials).toEqual({ token: "1:a" });
  });

  it("moves it from a Bot to a Representative and back, its listener following", async () => {
    const { deps, fake, context, startListeners } = sdkWith();
    const { user, client, representativeId, botId } = await anOwner(deps);
    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });
    await startListeners();
    const onBot = fake.listening.get("@bot_1")!.account.id;

    await connect(context, user.id, representativeId, "1:a");

    expect(await client.channels.accounts.list({ botId })).toEqual([
      { platform: "fake", fields: ["token"], account: null },
    ]);
    expect(await listChannelAccounts(context, user.id, representativeId)).toMatchObject([
      { handle: "@bot_1" },
    ]);
    await expect.poll(() => fake.listening.get("@bot_1")?.account.botId, poll).toBeNull();
    expect(fake.listening.get("@bot_1")!.account.id).not.toBe(onBot);

    await client.channels.accounts.save({ botId, platform: "fake", credentials: { token: "1:a" } });

    expect(await listChannelAccounts(context, user.id, representativeId)).toEqual([]);
    expect((await client.channels.accounts.list({ botId }))[0]!.account).toMatchObject({
      handle: "@bot_1",
    });
    expect(await getTestDb().select().from(representativeChannelAccount)).toEqual([]);
    await expect.poll(() => fake.listening.get("@bot_1")?.account.botId, poll).toBe(botId);
    expect(fake.listening.get("@bot_1")!.account.credentials).toEqual({ token: "1:a" });
  });

  it("moves it between the owner's Representatives, with its new credentials", async () => {
    const { deps, fake, context, startListeners } = sdkWith();
    const { user, client, representativeId } = await anOwner(deps);
    const { id: second } = await client.representative.create({ name: "Night desk" });
    await connect(context, user.id, representativeId, "1:a");
    await startListeners();

    await connect(context, user.id, second, "1:b");

    expect(await listChannelAccounts(context, user.id, representativeId)).toEqual([]);
    expect(await listChannelAccounts(context, user.id, second)).toMatchObject([
      { handle: "@bot_1" },
    ]);
    await expect
      .poll(() => fake.listening.get("@bot_1")?.account.credentials.token, poll)
      .toBe("1:b");
  });

  it("keeps it from another user, whichever side holds it", async () => {
    const { deps, context } = sdkWith();
    const ada = await anOwner(deps);
    const grace = await anOwner(deps);
    const taken = { data: { code: "error.channelAccountTaken" } };
    await connect(context, ada.user.id, ada.representativeId, "1:a");
    await grace.client.channels.accounts.save({
      botId: grace.botId,
      platform: "fake",
      credentials: { token: "2:b" },
    });

    await expect(
      grace.client.channels.accounts.save({
        botId: grace.botId,
        platform: "fake",
        credentials: { token: "1:a" },
      }),
    ).rejects.toMatchObject(taken);
    await expect(
      connect(context, grace.user.id, grace.representativeId, "1:a"),
    ).rejects.toMatchObject(taken);
    await expect(connect(context, ada.user.id, ada.representativeId, "2:b")).rejects.toMatchObject(
      taken,
    );
    expect(await listChannelAccounts(context, ada.user.id, ada.representativeId)).toMatchObject([
      { handle: "@bot_1" },
    ]);
  });

  it("lets one Representative hold several, on one platform or more", async () => {
    const fake = fakeMessagingAdapter();
    const other = fakeMessagingAdapter({ id: "other" });
    const deps = createTestSdk({
      channels: [fake.adapter, other.adapter],
      features: [representativeFeature()],
    });
    const context = deps.parts.features[0]!.context;
    const { user, representativeId } = await anOwner(deps);

    await connect(context, user.id, representativeId, "1:a");
    await connect(context, user.id, representativeId, "2:b");
    await connectChannelAccount(context, {
      userId: user.id,
      representativeId,
      platform: "other",
      credentials: { token: "1:c" },
    });

    const held = await listChannelAccounts(context, user.id, representativeId);
    expect(held.map(({ platform, handle }) => [platform, handle])).toEqual([
      ["fake", "@bot_1"],
      ["fake", "@bot_2"],
      ["other", "@bot_1"],
    ]);
  });

  it("stops the listener on rejected credentials and shows it needs attention, until saved again", async () => {
    const { deps, fake, context, startListeners } = sdkWith();
    const { user, representativeId } = await anOwner(deps);
    await connect(context, user.id, representativeId, "1:a");
    await startListeners();
    expect(fake.listening.has("@bot_1")).toBe(true);

    fake.revoke("1:a");

    await expect.poll(() => fake.listening.size, poll).toBe(0);
    await expect
      .poll(() => listChannelAccounts(context, user.id, representativeId), poll)
      .toMatchObject([{ status: "needs_attention", reason: "Unauthorized" }]);

    await connect(context, user.id, representativeId, "1:new");

    await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
    expect(await listChannelAccounts(context, user.id, representativeId)).toMatchObject([
      { status: "active", reason: null },
    ]);
  });

  it("marks a held account whose credentials no key reads as needing attention", async () => {
    const { deps, fake, context } = sdkWith(fakeMessagingAdapter(), [keyA]);
    const { user, representativeId } = await anOwner(deps);
    await connect(context, user.id, representativeId, "1:a");

    const keyless = sdkWith(fake, [keyB]);
    await keyless.startListeners();

    expect(fake.listening.size).toBe(0);
    expect(await listChannelAccounts(context, user.id, representativeId)).toMatchObject([
      { status: "needs_attention", reason: "The saved credentials can't be read" },
    ]);
  });

  it("isn't listened to by an instance with no feature to hold it", async () => {
    const { deps, fake, context } = sdkWith();
    const { user, representativeId } = await anOwner(deps);
    await connect(context, user.id, representativeId, "1:a");
    // Another keyring, too: what it can't read isn't its to mark.
    const bare = createTestSdk({ channels: [fake.adapter], keyEncryptionSecrets: [keyB] });
    const part = bare.parts.all.find((one) => one.id === "channel")!;

    await part.start!(bare);
    started.push({ part, deps: bare });

    expect(fake.listening.size).toBe(0);
    const [row] = await getTestDb().select().from(channelAccount);
    expect(row).toMatchObject({ status: "active", reason: null });
  });

  it("waits for a delete's lock on the Representative before it locks the account", async () => {
    const { deps, context } = sdkWith();
    const { user, representativeId } = await anOwner(deps);
    await connect(context, user.id, representativeId, "1:a");
    const [held] = await getTestDb().select({ id: channelAccount.id }).from(channelAccount);

    let saving: Promise<unknown> | undefined;
    await getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: representative.id })
        .from(representative)
        .where(eq(representative.id, representativeId))
        .for("update");
      saving = connect(context, user.id, representativeId, "1:b");
      await expect
        .poll(async () => {
          const { rows } = await getTestDb().execute(
            sql`select 1 from pg_stat_activity
                 where datname = current_database() and wait_event_type = 'Lock'
                   and query ilike '%"representative"%for update%'`,
          );
          return rows.length;
        }, poll)
        .toBeGreaterThan(0);
      // A connect that held the account here, waiting on the Representative, would deadlock a delete.
      await tx.select().from(channelAccount).where(eq(channelAccount.id, held!.id)).for("update", {
        noWait: true,
      });
    });
    await saving;
  });

  it("goes with the owner: deleted with its listener stopped, exported with no credentials", async () => {
    const { deps, fake, context, startListeners } = sdkWith();
    const ada = await anOwner(deps);
    const grace = await anOwner(deps);
    await connect(context, ada.user.id, ada.representativeId, "1:secret");
    await connect(context, grace.user.id, grace.representativeId, "2:other");
    await startListeners();

    const exported = await exportUserData(deps, ada.user.id);
    const { channelAccounts } = exported.representative as { channelAccounts: unknown };
    expect(channelAccounts).toMatchObject([
      { representativeId: ada.representativeId, platform: "fake", handle: "@bot_1" },
    ]);
    expect(JSON.stringify(channelAccounts)).not.toContain("secret");
    expect(JSON.stringify(channelAccounts)).not.toContain("v2.");

    await deleteUserData(deps, ada.user.id);

    expect(await getTestDb().select().from(channelAccount)).toHaveLength(1);
    await expect.poll(() => [...fake.listening.keys()], poll).toEqual(["@bot_2"]);
  });
});

describe("the owner's API for a Representative's Channel accounts (ticket #1358)", () => {
  it("lists the platforms the Host offers with their fields, then connects, lists and removes an account", async () => {
    const { deps, fake, startListeners } = sdkWith();
    const { client, representativeId } = await anOwner(deps);
    await startListeners();

    expect(await client.representative.channelAccountList({ id: representativeId })).toEqual({
      platforms: [{ platform: "fake", fields: ["token"] }],
      accounts: [],
    });

    const connected = await client.representative.channelAccountConnect({
      id: representativeId,
      platform: "fake",
      credentials: { token: "1:secret-token" },
    });

    expect(connected.accounts).toMatchObject([
      { platform: "fake", handle: "@bot_1", status: "active", reason: null },
    ]);
    expect(JSON.stringify(connected)).not.toContain("secret-token");
    expect(await client.representative.channelAccountList({ id: representativeId })).toEqual(
      connected,
    );
    await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);

    const removed = await client.representative.channelAccountRemove({
      id: representativeId,
      channelAccountId: connected.accounts[0]!.id,
    });

    expect(removed.accounts).toEqual([]);
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
    await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(false);
  });

  it("refuses another user's Representative, and removes nothing it doesn't hold", async () => {
    const { deps, fake } = sdkWith();
    const ada = await anOwner(deps);
    const grace = await anOwner(deps);
    const kept = await grace.client.representative.channelAccountConnect({
      id: grace.representativeId,
      platform: "fake",
      credentials: { token: "2:a" },
    });
    fake.rejected.add("9:revoked");

    await expect(
      grace.client.representative.channelAccountList({ id: ada.representativeId }),
    ).rejects.toMatchObject({ data: { code: "error.representativeNotFound" } });
    await expect(
      grace.client.representative.channelAccountConnect({
        id: ada.representativeId,
        platform: "fake",
        credentials: { token: "1:a" },
      }),
    ).rejects.toMatchObject({ data: { code: "error.representativeNotFound" } });
    await expect(
      ada.client.representative.channelAccountConnect({
        id: ada.representativeId,
        platform: "fake",
        credentials: { token: "9:revoked" },
      }),
    ).rejects.toMatchObject({ data: { code: "error.channelCredentialsRejected" } });
    // Grace's account, named through Ada's Representative or Grace's through another owner's.
    await ada.client.representative.channelAccountRemove({
      id: ada.representativeId,
      channelAccountId: kept.accounts[0]!.id,
    });
    await expect(
      grace.client.representative.channelAccountRemove({
        id: ada.representativeId,
        channelAccountId: kept.accounts[0]!.id,
      }),
    ).rejects.toMatchObject({ data: { code: "error.representativeNotFound" } });

    expect(await getTestDb().select().from(channelAccount)).toHaveLength(1);
  });
});
