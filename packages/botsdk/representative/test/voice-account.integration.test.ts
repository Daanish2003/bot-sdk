import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { encryptCredentials } from "@botsdk/bot/credentials/encryption";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { channelAccount } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { representativeChannelAccount } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";
import { voice } from "../src/server/voice-adapter";
import { defaultVoiceGreeting, maxVoiceGreetingLength } from "../src/shared/contract";

/*
 * A voice account on a Representative (ticket #1381, ADR 0036): connected with a number and a
 * greeting, a secret made and shown once, kept encrypted, and replaced at once on regenerate. Driven
 * through the feature's RPCs on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const key = "key-a-of-at-least-32-characters-long!!";
const linkUrl = "https://app.example/api/chat";
const number = "+15551234567";

function sdk(options: { offered?: boolean; linkUrl?: string | undefined } = {}) {
  const { offered = true } = options;
  const deps = createTestSdk({
    channels: [
      ...(offered ? [voice()] : []),
      fakeMessagingAdapter({ verifiesSender: true }).adapter,
    ],
    features: [
      representativeFeature({ linkUrl: "linkUrl" in options ? options.linkUrl : linkUrl }),
    ],
    keyEncryptionSecrets: [key],
  });
  const context = deps.parts.features.find(
    ({ feature }) => feature.id === "representative",
  )!.context;
  return { deps, context };
}

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
  return { user, client, representativeId };
}

/** An SMS account the Representative holds, as the database has it: only its number matters here. */
async function holdSms(representativeId: string, smsNumber: string) {
  const id = uuidv7();
  const now = new Date();
  await getTestDb().transaction(async (tx) => {
    await tx.insert(channelAccount).values({
      id,
      botId: null,
      platform: "sms",
      platformBotId: smsNumber,
      handle: smsNumber,
      encrypted: encryptCredentials(
        { apiKey: "k", publicKey: "p", number: smsNumber },
        { secrets: [key], kind: "channel", context: `${id}:sms` },
      ),
      status: "active",
      reason: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .insert(representativeChannelAccount)
      .values({ channelAccountId: id, representativeId });
  });
}

describe("connecting a voice account", () => {
  it("keeps the number and greeting, shows the hook URL, and returns the secret once", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);

    const { secret, view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number: "+1 (555) 123-4567",
      greeting: "Hi, this is Front desk.",
    });

    const [account] = view.accounts;
    expect(view.accounts).toHaveLength(1);
    expect(account).toMatchObject({
      platform: "voice",
      handle: number,
      status: "active",
      webhookUrl: null,
      voice: {
        greeting: "Hi, this is Front desk.",
        hookUrl: `${linkUrl}/representative/voice/${account!.id}`,
        smsPaired: false,
      },
    });
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // Neither this view nor a later one holds the secret.
    expect(JSON.stringify(view)).not.toContain(secret);
    const later = await client.representative.channelAccountList({ id: representativeId });
    expect(JSON.stringify(later)).not.toContain(secret);
  });

  it("greets with a default when none is given", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);

    const { view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
      greeting: "  ",
    });

    expect(view.accounts[0]!.voice!.greeting).toBe(defaultVoiceGreeting);
  });

  it("refuses a badly formed number and connects nothing", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);

    for (const bad of ["5551234567", "+0123456789", "+1555", "call me", "+1555123456789012"]) {
      await expect(
        client.representative.voiceAccountConnect({ id: representativeId, number: bad }),
      ).rejects.toMatchObject({ data: { code: "error.voiceNumberInvalid" } });
    }
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("stores the secret and greeting encrypted under the keyring, readable only through the service", async () => {
    const { deps, context } = sdk();
    const { client, representativeId } = await anOwner(deps);

    const { secret, view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
      greeting: "Hello there.",
    });

    const [row] = await getTestDb().select().from(channelAccount);
    expect(row!.encrypted).toMatch(/^v2\./);
    expect(row!.encrypted).not.toContain(secret);
    expect(row!.encrypted).not.toContain("Hello there.");
    expect(await context.channelAccounts.credentialsOf(view.accounts[0]!.id, "voice")).toEqual({
      number,
      greeting: "Hello there.",
      secret,
    });
  });

  it("asks for no provider and no vendor key, and never takes a secret the owner chose", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);

    const list = await client.representative.channelAccountList({ id: representativeId });

    // The generic form never offers voice: it has its own, with no key fields.
    expect(list.voiceOffered).toBe(true);
    expect(list.platforms.map(({ platform }) => platform)).toEqual(["fake"]);
    await expect(
      client.representative.channelAccountConnect({
        id: representativeId,
        platform: "voice",
        credentials: { number, greeting: "x", secret: "chosen" },
      }),
    ).rejects.toMatchObject({ data: { code: "error.channelPlatformNotFound" } });
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("shows no voice when the Host offers no voice adapter", async () => {
    const { deps } = sdk({ offered: false });
    const { client, representativeId } = await anOwner(deps);

    expect(await client.representative.channelAccountList({ id: representativeId })).toMatchObject({
      voiceOffered: false,
    });
    await expect(
      client.representative.voiceAccountConnect({ id: representativeId, number }),
    ).rejects.toMatchObject({ data: { code: "error.channelPlatformNotFound" } });
  });

  it("has no hook URL while the Host gives no linkUrl", async () => {
    const { deps } = sdk({ linkUrl: undefined });
    const { client, representativeId } = await anOwner(deps);

    const { view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
    });

    expect(view.accounts[0]!.voice!.hookUrl).toBeNull();
  });

  it("refuses another owner's Representative", async () => {
    const { deps } = sdk();
    const { representativeId } = await anOwner(deps);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(
      other.representative.voiceAccountConnect({ id: representativeId, number }),
    ).rejects.toMatchObject({ data: { code: "error.representativeNotFound" } });
    expect(await getTestDb().select().from(channelAccount)).toEqual([]);
  });

  it("pairs with an SMS account on the same number, with no setting", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);
    await holdSms(representativeId, "+15559998888");

    const apart = await client.representative.voiceAccountConnect({ id: representativeId, number });
    expect(apart.view.accounts.find(({ platform }) => platform === "voice")!.voice!.smsPaired).toBe(
      false,
    );

    await holdSms(representativeId, number);
    const list = await client.representative.channelAccountList({ id: representativeId });
    expect(list.accounts.find(({ platform }) => platform === "voice")!.voice!.smsPaired).toBe(true);
  });
});

describe("regenerating the secret", () => {
  it("replaces it at once, keeping the account, number and greeting", async () => {
    const { deps, context } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const first = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
      greeting: "Keep me.",
    });
    const accountId = first.view.accounts[0]!.id;

    const second = await client.representative.voiceAccountRegenerate({
      id: representativeId,
      channelAccountId: accountId,
    });

    expect(second.secret).not.toBe(first.secret);
    expect(second.view.accounts.map(({ id }) => id)).toEqual([accountId]);
    expect(await context.channelAccounts.credentialsOf(accountId, "voice")).toEqual({
      number,
      greeting: "Keep me.",
      secret: second.secret,
    });
    expect(JSON.stringify(second.view)).not.toContain(second.secret);
  });

  it("refuses an account that isn't a voice account of this Representative", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const other = await anOwner(deps);
    const mine = await client.representative.voiceAccountConnect({ id: representativeId, number });
    await holdSms(representativeId, "+15559998888");
    const [sms] = await getTestDb()
      .select()
      .from(channelAccount)
      .where(eq(channelAccount.platform, "sms"));

    await expect(
      other.client.representative.voiceAccountRegenerate({
        id: other.representativeId,
        channelAccountId: mine.view.accounts[0]!.id,
      }),
    ).rejects.toMatchObject({ data: { code: "error.voiceAccountNotFound" } });
    await expect(
      client.representative.voiceAccountRegenerate({
        id: representativeId,
        channelAccountId: sms!.id,
      }),
    ).rejects.toMatchObject({ data: { code: "error.voiceAccountNotFound" } });
  });
});

describe("the voice adapter", () => {
  it("neither receives nor sends: no listener, no webhook, and a send fails", async () => {
    const adapter = voice();
    const { deps, context } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const { view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
    });

    expect(adapter.listen).toBeUndefined();
    expect(adapter.webhook).toBeUndefined();
    expect(context.channelAccounts.webhookUrl("voice", view.accounts[0]!.id)).toBeNull();
    await expect(
      context.channelAccounts.send(view.accounts[0]!.id, { chatId: number, text: "hi" }),
    ).rejects.toThrow();
  });
});

describe("changing the greeting", () => {
  it("changes only the greeting: the account, number and secret stay, with no new approval", async () => {
    const { deps, context } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const { secret, view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
      greeting: "Old greeting.",
    });
    const accountId = view.accounts[0]!.id;

    const changed = await client.representative.voiceAccountSetGreeting({
      id: representativeId,
      channelAccountId: accountId,
      greeting: "  New greeting.  ",
    });

    expect(changed.accounts.map(({ id }) => id)).toEqual([accountId]);
    expect(changed.accounts[0]!.voice!.greeting).toBe("New greeting.");
    expect(await context.channelAccounts.credentialsOf(accountId, "voice")).toEqual({
      number,
      greeting: "New greeting.",
      secret,
    });
    expect(JSON.stringify(changed)).not.toContain(secret);
  });

  it("goes back to the default for an empty greeting, as connecting does, and refuses a too long one", async () => {
    const { deps, context } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const { secret, view } = await client.representative.voiceAccountConnect({
      id: representativeId,
      number,
      greeting: "Custom.",
    });
    const accountId = view.accounts[0]!.id;

    const emptied = await client.representative.voiceAccountSetGreeting({
      id: representativeId,
      channelAccountId: accountId,
      greeting: "  ",
    });
    expect(emptied.accounts[0]!.voice!.greeting).toBe(defaultVoiceGreeting);

    const tooLong = "x".repeat(maxVoiceGreetingLength + 1);
    await expect(
      client.representative.voiceAccountSetGreeting({
        id: representativeId,
        channelAccountId: accountId,
        greeting: tooLong,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.representative.voiceAccountConnect({
        id: representativeId,
        number: "+15557654321",
        greeting: tooLong,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await context.channelAccounts.credentialsOf(accountId, "voice")).toEqual({
      number,
      greeting: defaultVoiceGreeting,
      secret,
    });
  });

  it("refuses an account that isn't a voice account of this Representative", async () => {
    const { deps } = sdk();
    const { client, representativeId } = await anOwner(deps);
    const other = await anOwner(deps);
    const mine = await client.representative.voiceAccountConnect({ id: representativeId, number });

    await expect(
      other.client.representative.voiceAccountSetGreeting({
        id: other.representativeId,
        channelAccountId: mine.view.accounts[0]!.id,
        greeting: "Hijacked.",
      }),
    ).rejects.toMatchObject({ data: { code: "error.voiceAccountNotFound" } });
  });
});
