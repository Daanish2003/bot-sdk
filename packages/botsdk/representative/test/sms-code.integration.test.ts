import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { BotSdkPlugin } from "@botsdk/bot/plugin";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { autoSource, promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectChannelAccount } from "../src/server/channel-accounts";
import {
  representativeCustomerIdentity,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";

/*
 * An SMS Customer proves they hold their number by a code round trip (ticket #1359): a text from a
 * held SMS account carries the `codeRoundTrip` rule, `verify_customer` texts the code to the sender's
 * number through the account that heard them, and the reply that carries it is caught before it is
 * stored. Over `fakeMessagingAdapter` as the "sms" Channel, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const poll = { timeout: 10_000 };
const silent = { error: () => {} };
const model = "openai:gpt-6-luna";
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");
const day = 24 * 60 * 60_000;

const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );
const verifies = () => round(toolCall({ name: "verify_customer", input: {}, id: "verify" }));

const runners: JobRunner[] = [];
const started: { part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { part, deps } of started.splice(0)) await part.stop!(deps);
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance whose Model plays `rounds` in turn, and whose SMS account is a fake platform's. */
async function world(rounds: ReturnType<typeof round>[]) {
  const channel = fakeMessagingAdapter({ id: "sms" });
  const fake = createFakeAdapter({ rounds });
  const timer = fakeJobClock(at);
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => made!.parts.jobs,
  });
  const deps = createTestSdk({
    jobs,
    channels: [channel.adapter],
    features: [representativeFeature()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
  });
  made = deps;
  await jobs.start();
  runners.push(jobs);
  const part = deps.parts.all.find((one) => one.id === "channel")!;
  await part.start!(deps);
  started.push({ part, deps });

  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const context = deps.parts.features.find(
    ({ feature }) => feature.id === "representative",
  )!.context;
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "verify_customer"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  await connectChannelAccount(context, {
    userId: user.id,
    representativeId: id,
    platform: "sms",
    credentials: { token: "1:a" },
  });

  const number = "+15550001";
  return {
    channel,
    fake,
    timer,
    rpc,
    /** A Customer on file under the number, with something the Model may only read once they're verified. */
    knownAs: async () => {
      const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: number });
      await rpc.representative.customerProfileSet({
        id: ada.id,
        field: "language",
        value: "Dutch",
      });
    },
    /** The Customer texts the line, and lets the Turn it started run. */
    texts: async (text: string) => {
      await expect.poll(() => channel.listening.has("@bot_1"), poll).toBe(true);
      await channel.deliver("@bot_1", {
        text,
        sender: { id: number, handle: number },
        chat: { id: number, private: true },
      });
      timer.advance(batchLongestMs);
      timer.tick();
    },
  };
}

const threadMessages = () =>
  getTestDb()
    .select({
      author: representativeThreadMessage.author,
      text: representativeThreadMessage.text,
      verified: representativeThreadMessage.verified,
    })
    .from(representativeThreadMessage)
    .orderBy(asc(representativeThreadMessage.position));

const identity = async () => (await getTestDb().select().from(representativeCustomerIdentity))[0]!;

const prompts = (fake: { calls: { messages: unknown }[] }) =>
  fake.calls.map((call) => JSON.stringify(call.messages));

/** The six-digit code in the text the line sent. */
const codeSent = (channel: { delivered: { part: string }[] }) =>
  channel.delivered.map(({ part }) => /\b\d{6}\b/.exec(part)?.[0]).find(Boolean);

describe("a code round trip on SMS", () => {
  it("texts the code to the sender's number through the account that heard them, and stores no message of it", async () => {
    const { channel, texts } = await world([verifies(), round()]);

    await texts("It is me, Ada");

    await expect.poll(() => codeSent(channel), poll).toMatch(/^\d{6}$/);
    expect(channel.sends.map(({ account }) => account.handle)).toEqual(["@bot_1"]);
    expect(channel.delivered.map(({ chatId }) => chatId)).toEqual(["+15550001"]);
    expect(JSON.stringify(await threadMessages())).not.toContain(codeSent(channel)!);
    expect((await identity()).verifiedContactAt).toBeNull();
  });

  it("verifies the identity by the right code, and the next Turn has the Customer's memory", async () => {
    const { channel, fake, knownAs, texts } = await world([
      verifies(),
      round(),
      replies("Hello."),
      round(),
    ]);
    await knownAs();
    await texts("It is me, Ada");
    await expect.poll(() => codeSent(channel), poll).toBeDefined();
    const code = codeSent(channel)!;
    expect(prompts(fake).join("")).not.toContain("Dutch");

    await texts(`here: ${code}`);

    await expect.poll(async () => (await identity()).verifiedContactAt, poll).not.toBeNull();
    await expect.poll(() => prompts(fake).at(-1), poll).toContain("Dutch");
    for (const prompt of prompts(fake)) expect(prompt).not.toContain(code);
    expect(JSON.stringify(await threadMessages())).not.toContain(code);
  });

  it("unlocks nothing for a wrong code", async () => {
    const { channel, fake, knownAs, texts } = await world([
      verifies(),
      round(),
      replies("Hello."),
      round(),
    ]);
    await knownAs();
    await texts("It is me, Ada");
    await expect.poll(() => codeSent(channel), poll).toBeDefined();
    const wrong = codeSent(channel) === "000000" ? "111111" : "000000";

    await texts(wrong);

    // The note the wrong code left in the thread shows it was looked at and refused.
    await expect
      .poll(async () => (await threadMessages()).map(({ text }) => text).join(" "), poll)
      .toContain("It was wrong");
    expect((await identity()).verifiedContactAt).toBeNull();
    expect(prompts(fake).join("")).not.toContain("Dutch");
  });

  it("lapses after 90 days without contact, and the Customer's memory is shut again", async () => {
    const { channel, fake, timer, knownAs, texts } = await world([verifies(), round(), round()]);
    await knownAs();
    await texts("It is me, Ada");
    await expect.poll(() => codeSent(channel), poll).toBeDefined();
    await texts(codeSent(channel)!);
    await expect.poll(async () => (await identity()).verifiedContactAt, poll).not.toBeNull();

    // The Turn the code started has run its Model call.
    await expect.poll(() => fake.calls.length, poll).toBe(3);
    timer.advance(91 * day);
    const before = prompts(fake).length;
    await texts("Back again");

    // Stored state: a 91-day leap also meets the idle job, which moves the message to a new thread.
    await expect
      .poll(
        async () => (await threadMessages()).filter(({ author }) => author === "customer").length,
        poll,
      )
      .toBe(3);
    expect((await threadMessages()).findLast(({ author }) => author === "customer")).toMatchObject({
      text: "Back again",
      verified: false,
    });
    expect(prompts(fake).slice(before).join("")).not.toContain("Dutch");
    // The standing ended, so the number has to prove itself again.
    expect(await identity()).toMatchObject({ lapsedAt: expect.any(Date) });
  });
});
