import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessagingReach } from "@botsdk/bot/channel";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  autoSource,
  testCustomerHeard,
  testCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { cutMarker, sms } from "../../channel-sms/src";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import { storeReply } from "../src/server/customers";
import { representativeOutboundDecision } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";
import { optOutConfirmation } from "../src/server/opt-out";

/*
 * The gate's rules on SMS (ticket #1360), through the real inbound and reply paths. The Customer
 * channel is a `fakeMessagingAdapter` with id `sms`, and the reach the Telnyx adapter declares: it can't
 * start a conversation, and its longest message is three segments (3 x 153 characters), which the
 * adapter cuts itself.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550002";
const noon = new Date("2026-11-04T12:00:00Z");
const smsReach: MessagingReach = {
  canStartConversation: false,
  maxLength: 459,
  cutsLongMessages: true,
};

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** `real`: the Customer channel sends through the real `sms()` adapter, over a fetch that records the texts it posts, and declares its reach. */
async function instance(real = false, declared: MessagingReach = smsReach) {
  const posted: string[] = [];
  const realSms = sms();
  const smsFetch = (async (_url: unknown, init?: { body?: string }) => {
    posted.push((JSON.parse(init?.body ?? "{}") as { text: string }).text);
    return Response.json({ data: { id: "o" } });
  }) as unknown as typeof fetch;
  const smsAccount = {
    id: "account",
    botId: "bot",
    platformBotId: "x",
    handle: "x",
    credentials: { apiKey: "KEY", publicKey: "", number: "+15550001111" },
  };
  const fake = createFakeAdapter({ rounds: [round(), round(), round(), round()] });
  const adapter: AnyTextAdapter = fake.adapter;
  const messaging = fakeMessagingAdapter({ id: "sms" });
  const account = {
    id: "account",
    botId: "bot",
    platformBotId: "1",
    handle: "@bot_1",
    credentials: { token: "1:secret" },
  };
  const channel: CustomerChannel = {
    send: async (to, { text }) => {
      if (real)
        await realSms.send(smsAccount, { chatId: to.externalId, text }, { fetch: smsFetch });
      else await messaging.adapter.send(account, { chatId: to.externalId, text }, { fetch });
    },
    sendProof: async () => {},
    reach: () => (real ? realSms : declared),
  };
  const timer = fakeJobClock(noon);
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
    features: [representativeFeature({}, channel)],
    adapterFor: () => adapter,
    clock: timer.clock.now,
    memory: false,
  });
  made = deps;
  await jobs.start();
  runners.push(jobs);

  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "...-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  return {
    messaging,
    posted,
    rpc,
    id,
    threadId,
    /** An SMS from the Customer, answered by a Turn that runs to its end (none, for STOP and START). */
    hears: (message: string) =>
      testCustomerTurn(deps, { representativeId: id, externalId: number, message, channel: "sms" }),
    /** An SMS from the Customer, with no Turn run. */
    heard: (message: string) =>
      testCustomerHeard(deps, {
        representativeId: id,
        externalId: number,
        message,
        channel: "sms",
      }),
    got: () => messaging.delivered.map(({ part }) => part),
    decisions: async () =>
      (
        await getTestDb()
          .select()
          .from(representativeOutboundDecision)
          .where(eq(representativeOutboundDecision.threadId, await threadId()))
          .orderBy(asc(representativeOutboundDecision.id))
      ).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    /** The Representative's reply as the tool stores it, from a Turn still running. */
    reply: async (text: string, businessStarted = false) => {
      const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
      const thread = await threadId();
      return getTestDb().transaction((tx) =>
        storeReply(
          { ...feature.context, channel },
          tx,
          {
            threadId: thread,
            upTo: 1,
            heard: { channel: "sms", externalId: number },
            verified: false,
            businessStarted,
          },
          { text, sources: [autoSource], topic: "general" },
          "small_talk",
          noon,
        ),
      );
    },
  };
}

describe("STOP and START on SMS", () => {
  it("opts the Customer out with the fixed confirmation, then blocks later replies", async () => {
    const world = await instance();

    await world.hears("STOP");
    const blocked = await world.reply("Still here");

    expect(blocked).toHaveProperty("error");
    await expect.poll(world.got, poll).toEqual([optOutConfirmation]);
    expect(await world.decisions()).toEqual([
      ["opt_out_confirmation", "send", "passed"],
      ["reply", "drop", "optedOut"],
    ]);
  });

  it.each(["stopall", "Unsubscribe", "cancel", "END", "quit"])("reads %s as STOP", async (word) => {
    const world = await instance();

    await world.hears(word);

    await expect.poll(world.got, poll).toEqual([optOutConfirmation]);
  });

  it.each(["START", "UNSTOP"])("lifts the opt-out on %s", async (word) => {
    const world = await instance();
    await world.hears("STOP");

    await world.hears(word);

    expect(await world.reply("Welcome back")).toEqual({ sent: true });
    await expect.poll(world.got, poll).toEqual([optOutConfirmation, "Welcome back"]);
  });
});

describe("the Channel rule on SMS", () => {
  it("holds a text the business would start, since the adapter can't start a conversation", async () => {
    const world = await instance();
    await world.heard("Hello");

    const started = await world.reply("Your order shipped", true);

    expect(started).toMatchObject({ error: expect.stringContaining("held") });
    expect(world.got()).toEqual([]);
    expect(await world.decisions()).toEqual([["reply", "hold", "channel"]]);
  });

  it("sends a reply to a Customer who just wrote", async () => {
    const world = await instance();
    await world.heard("Hello");

    expect(await world.reply("Hi")).toEqual({ sent: true });
  });

  it("still holds a reply over maxLength when the adapter doesn't say it cuts", async () => {
    const world = await instance(false, { canStartConversation: false, maxLength: 459 });
    await world.heard("Hello");

    const long = await world.reply("word ".repeat(120));

    expect(long).toMatchObject({ error: expect.stringContaining("held") });
    expect(await world.decisions()).toEqual([["reply", "hold", "channel"]]);
  });

  it("lets the real adapter cut a reply over 459 characters, and say so", async () => {
    const world = await instance(true);
    await world.heard("Hello");

    expect(await world.reply("word ".repeat(120))).toEqual({ sent: true });

    expect(await world.decisions()).toEqual([["reply", "send", "passed"]]);
    // The reply goes out by a delivery job, which may not have run yet.
    await expect.poll(() => world.posted.length, poll).toBe(1);
    expect(world.posted[0]!.endsWith(cutMarker)).toBe(true);
    expect(world.posted[0]!.length).toBeLessThanOrEqual(459);
  });

  it("passes a reply over maxLength to the adapter (which cuts it, in #1356) rather than holding it", async () => {
    const world = await instance();
    await world.heard("Hello");

    const long = await world.reply("word ".repeat(120));

    expect(long).toEqual({ sent: true });
    expect(await world.decisions()).toEqual([["reply", "send", "passed"]]);
  });
});

describe("the caps on SMS", () => {
  it("holds what goes past the cap in a row, so texts cost no more than the owner set", async () => {
    const world = await instance();
    await world.heard("Hello");
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 2 });

    const results = [];
    for (const text of ["One", "Two", "Three", "Four"]) results.push(await world.reply(text));

    expect(results.map((result) => ("error" in result ? "held" : "sent"))).toEqual([
      "sent",
      "sent",
      "held",
      "held",
    ]);
    expect(world.got()).toEqual(["One", "Two"]);
    expect(await world.decisions()).toEqual([
      ["reply", "send", "passed"],
      ["reply", "send", "passed"],
      ["reply", "hold", "caps"],
      ["reply", "hold", "caps"],
    ]);
  });

  it("holds past the per-day cap", async () => {
    const world = await instance();
    await world.heard("Hello");
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 100, maxPerDay: 1 });

    await world.reply("One");
    const second = await world.reply("Two");

    expect(second).toMatchObject({ error: expect.stringContaining("held") });
    expect(world.got()).toEqual(["One"]);
  });
});
