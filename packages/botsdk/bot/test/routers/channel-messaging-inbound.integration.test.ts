import { maxFileBytes } from "@botsdk/client/bot/files";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTrigger, channelAccount, linkedIdentity, message } from "../../src/storage";
import { findBot } from "../../src/bot/conversation";
import { uuidv7 } from "../../src/lib/uuidv7";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { saveCredentials } from "../../src/models/internal";
import type { BotSdkPlugin } from "../../src/plugin";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

/*
 * A message from the user's Linked identity wakes the Bot (spec #1044, ticket #1047), through the
 * fake messaging adapter's listener.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const at = new Date("2026-10-22T09:00:00.000Z");

const started: { jobs: JobRunner; part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { jobs, part, deps } of started.splice(0)) {
    await part.stop!(deps);
    await jobs.stop();
  }
});

/**
 * A Bot whose Channel account is `@bot_1` on the fake platform, its user Linked as platform user
 * `1001`, on an idle runner and a fixed clock. `runDue()` runs every job due until none is left.
 */
async function telegramBot({ isBlocked }: { isBlocked?: () => Promise<boolean> } = {}) {
  const timer = fakeJobClock(at);
  const brain = createFakeAdapter({ rounds: [round(), round(), round()] });
  const fake = fakeMessagingAdapter();
  const logged: string[] = [];
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  const user = await insertUser();
  deps = createTestSdk({
    channels: [fake.adapter],
    users: { isBlocked },
    jobs,
    adapterFor: () => brain.adapter,
    clock: timer.clock.now,
    logger: { error: (text: unknown) => void logged.push(String(text)) },
  });
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada Lovelace", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  await client.channels.accounts.save({
    botId,
    platform: "fake",
    credentials: { token: "1:secret" },
  });
  const [account] = await getTestDb()
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.botId, botId));
  await getTestDb().insert(linkedIdentity).values({
    id: uuidv7(),
    userId: user.id,
    platform: "fake",
    platformUserId: "1001",
    handle: "@ada",
    workspaceId: null,
    linkedAt: at,
  });
  const part = deps.parts.all.find((candidate) => candidate.id === "channel")!;
  await part.start!(deps);
  started.push({ jobs, part, deps });
  await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  return {
    fake,
    brain,
    client,
    botId,
    conversationId,
    accountId: account!.id,
    timer,
    runDue,
    logged,
  };
}

const triggersOf = (conversationId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.conversationId, conversationId))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));

const userMessagesOf = (conversationId: string) =>
  getTestDb()
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, "user")));

describe("a message from the Linked identity", () => {
  it("becomes a user Message and a Trigger on the platform's Channel, and starts a Turn", async () => {
    const { fake, brain, client, botId, conversationId, accountId, timer, runDue } =
      await telegramBot();

    await fake.deliver("@bot_1", { sourceId: "1001:77", text: "Book me a table for Friday" });

    const [trigger, ...more] = await triggersOf(conversationId);
    expect(more).toEqual([]);
    expect(trigger).toMatchObject({
      id: `fake:${accountId}:1001:77`,
      source: "user",
      channel: "fake",
      turnId: expect.any(String),
    });
    const { messages } = await client.bots.get({ botId });
    expect(messages).toEqual([
      expect.objectContaining({
        id: trigger!.messageId,
        role: "user",
        text: "Book me a table for Friday",
        channel: "fake",
      }),
    ]);
    timer.advance(500);
    await runDue();
    expect(brain.calls).toHaveLength(1);
    expect(JSON.stringify(brain.calls[0]!.messages)).toContain("Book me a table for Friday");
  });

  it("makes no second Message or Trigger for a resent update", async () => {
    const { fake, conversationId, logged } = await telegramBot();

    await fake.deliver("@bot_1", { sourceId: "1001:77", text: "Hello" });
    await fake.deliver("@bot_1", { sourceId: "1001:77", text: "Hello" });

    expect(await triggersOf(conversationId)).toHaveLength(1);
    expect(await userMessagesOf(conversationId)).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it("batches quick messages into one Turn", async () => {
    const { fake, brain, conversationId, timer, runDue } = await telegramBot();

    await fake.deliver("@bot_1", { sourceId: "1001:1", text: "First" });
    await fake.deliver("@bot_1", { sourceId: "1001:2", text: "Second" });
    timer.advance(3_000);
    await runDue();

    const triggers = await triggersOf(conversationId);
    expect(triggers).toHaveLength(2);
    expect(new Set(triggers.map((row) => row.turnId)).size).toBe(1);
    expect(brain.calls).toHaveLength(1);
  });

  it("is skipped for a paused Bot: a skipped Trigger and no Message", async () => {
    const { fake, client, botId, conversationId } = await telegramBot();
    await client.bots.pause({ botId });

    await fake.deliver("@bot_1", { sourceId: "1001:1", text: "Hello" });

    expect(await userMessagesOf(conversationId)).toEqual([]);
    expect(
      (await triggersOf(conversationId)).map((row) => [row.channel, row.messageId, row.skipReason]),
    ).toEqual([["fake", null, "paused"]]);
    expect((await client.bots.tasks({ botId })).done.skipped).toHaveLength(1);
  });

  it("is blocked for a Banned user, until the Ban ends", async () => {
    let banned = true;
    const { fake, conversationId } = await telegramBot({ isBlocked: async () => banned });

    await fake.deliver("@bot_1", { sourceId: "1001:1", text: "Hello" });
    expect(await triggersOf(conversationId)).toEqual([]);
    expect(await userMessagesOf(conversationId)).toEqual([]);

    banned = false;
    await fake.deliver("@bot_1", { sourceId: "1001:2", text: "Hello" });
    expect(await triggersOf(conversationId)).toHaveLength(1);
  });

  it("is dropped from a group or channel chat, from another sender, and when it holds nothing", async () => {
    const { fake, conversationId } = await telegramBot();

    await fake.deliver("@bot_1", { chat: { id: "-5", private: false }, text: "Hello" });
    await fake.deliver("@bot_1", {
      sender: { id: "2002", handle: "@eve" },
      chat: { id: "2002", private: true },
      text: "Hello",
    });
    await fake.deliver("@bot_1", { text: "" });

    expect(await triggersOf(conversationId)).toEqual([]);
    expect(await userMessagesOf(conversationId)).toEqual([]);
  });
});

describe("the files of a message from the Linked identity", () => {
  it("keeps photos and documents as Attachments, as the owner's email attachments are", async () => {
    const { fake, client, botId, conversationId } = await telegramBot();
    fake.files.set("p1", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
    fake.files.set("d1", new TextEncoder().encode("milk, eggs"));

    await fake.deliver("@bot_1", {
      text: "Here",
      files: [
        { id: "p1", name: "photo.jpg", contentType: "image/jpeg", size: 4, kind: "photo" },
        { id: "d1", name: "notes.txt", contentType: "text/plain", size: 10, kind: "document" },
      ],
    });

    const { messages } = await client.bots.get({ botId });
    expect(messages[0]!.text).toBe("Here");
    expect(messages[0]!.control).toEqual({
      kind: "files",
      files: [
        { id: expect.any(String), name: "photo.jpg", size: 4, mediaType: "image/jpeg" },
        { id: expect.any(String), name: "notes.txt", size: 10, mediaType: "text/plain" },
      ],
    });
    expect(await triggersOf(conversationId)).toHaveLength(1);
  });

  it("keeps a message that holds only a file", async () => {
    const { fake, conversationId } = await telegramBot();
    fake.files.set("d1", new TextEncoder().encode("x"));

    await fake.deliver("@bot_1", {
      files: [{ id: "d1", name: "a.txt", contentType: "text/plain", size: 1, kind: "document" }],
    });

    expect(await triggersOf(conversationId)).toHaveLength(1);
  });

  it("leaves out a file past the platform's limit without downloading it, with a note", async () => {
    const { fake, client, botId } = await telegramBot();

    await fake.deliver("@bot_1", {
      text: "Look",
      files: [
        {
          id: "big",
          name: "big.mov",
          contentType: "video/quicktime",
          size: fake.adapter.limits.download + 1,
          kind: "document",
        },
      ],
    });

    const { messages } = await client.bots.get({ botId });
    expect(messages[0]!.text).toBe("Look\n\nFiles not kept (too large): big.mov");
    expect(messages[0]!.control).toBeUndefined();
    expect(fake.downloads).toEqual([]);
  });

  it("leaves out a file past the SDK's limit when the platform doesn't say its size", async () => {
    const { fake, client, botId } = await telegramBot();
    fake.adapter.limits.download = maxFileBytes * 2;
    fake.files.set("big", new Uint8Array(maxFileBytes + 1));

    await fake.deliver("@bot_1", {
      files: [
        {
          id: "big",
          name: "big.bin",
          contentType: "application/octet-stream",
          size: null,
          kind: "document",
        },
      ],
    });

    const { messages } = await client.bots.get({ botId });
    expect(messages[0]!.text).toBe("Files not kept (too large): big.bin");
    expect(messages[0]!.control).toBeUndefined();
  });

  it("keeps a voice note as an Attachment, saying it isn't transcribed", async () => {
    const { fake, client, botId } = await telegramBot();
    fake.files.set("v1", new TextEncoder().encode("ogg"));

    await fake.deliver("@bot_1", {
      files: [{ id: "v1", name: "voice.ogg", contentType: "audio/ogg", size: 3, kind: "voice" }],
    });

    const { messages } = await client.bots.get({ botId });
    expect(messages[0]!.text).toBe("(voice note, not transcribed yet)");
    expect(messages[0]!.control).toEqual({
      kind: "files",
      files: [{ id: expect.any(String), name: "voice.ogg", size: 3, mediaType: "audio/ogg" }],
    });
  });
});
