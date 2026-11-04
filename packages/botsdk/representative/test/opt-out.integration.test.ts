import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import { storeReply } from "../src/server/customers";
import { holdingNote } from "../src/server/reply-drafts";
import { representativeOutboundDecision } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";

/*
 * A Customer opts out and comes back (ticket #1302), through the real inbound and reply paths: a fake
 * Model on real Postgres, and a Customer channel over `fakeMessagingAdapter`. What a Customer got is
 * what the fake recorded, and why is the decision log.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550002";
/** The fixed words a Customer is sent once they opt out. */
const confirmation = "You won't get any more messages from us. Reply START to hear from us again.";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) =>
  round(toolCall({ name: "reply", input: { topic: "general", text, kind: "small_talk" } }));
/** A reply with no topic: the gate holds it as a draft for the owner. */
const drafts = (text: string) =>
  round(toolCall({ name: "reply", input: { text, kind: "small_talk" } }));

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance whose Customer channel sends through a fake messaging adapter. */
async function instance(rounds: Round[], tools: string[] = ["reply"]) {
  const fake = createFakeAdapter({ rounds });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      yield* fake.adapter.chatStream(options);
    },
  };
  const messaging = fakeMessagingAdapter();
  const account = {
    id: "account",
    botId: "bot",
    platformBotId: "1",
    handle: "@bot_1",
    credentials: { token: "1:secret" },
  };
  const channel: CustomerChannel = {
    send: async (to, { text }) => {
      await messaging.adapter.send(account, { chatId: to.externalId, text }, { fetch });
    },
    sendProof: async () => {},
  };
  const timer = fakeJobClock(new Date());
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
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: tools as never },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  const hears = (message: string, channel?: string, externalId = number) =>
    testCustomerTurn(world, { representativeId: id, externalId, message, channel });
  return {
    messaging,
    entered,
    rpc,
    id,
    deps: world,
    threadId,
    hears,
    /** What reached the Customer, in the order the fake sent it. */
    got: () => messaging.delivered.map(({ part }) => part),
    thread: async () => rpc.representative.threadGet({ id: await threadId() }),
    decisions: async () =>
      getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, await threadId()))
        .orderBy(asc(representativeOutboundDecision.id)),
    /** The Representative's reply, as the tool stores it, from a Turn still running. */
    reply: async (text: string) => {
      const feature = world.parts.features.find(({ feature }) => feature.id === "representative")!;
      const thread = await threadId();
      return getTestDb().transaction((tx) =>
        storeReply(
          feature.context,
          tx,
          {
            threadId: thread,
            upTo: 1,
            heard: { channel: "fake", externalId: number },
            verified: false,
          },
          { text, sources: [], topic: "general" },
          "small_talk",
          new Date(),
        ),
      );
    },
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** The identity of the Customer at `number`, as the owner sees it. */
const identity = async (world: World) => (await world.thread()).identities[0]!;

describe("a Customer's STOP", () => {
  it("opts them out at once with no model call, and the gate drops what comes after", async () => {
    const world = await instance([]);

    await world.hears("STOP");

    expect(world.entered).toEqual([]);
    expect(await identity(world)).toMatchObject({
      optedOut: { source: "keyword", at: expect.any(Date) },
    });
    const { sent, ...stored } = await world.reply("Still here").then((answer) => ({
      sent: "sent" in answer,
      ...answer,
    }));
    expect(sent).toBe(false);
    expect(stored).toHaveProperty("error");
    await expect.poll(world.got, poll).toEqual([confirmation]);
    expect(
      (await world.decisions()).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    ).toEqual([
      ["opt_out_confirmation", "send", "passed"],
      ["reply", "drop", "optedOut"],
    ]);
  });

  it("sends exactly one confirmation, however many times they say it", async () => {
    const world = await instance([]);

    await world.hears("STOP");
    await world.hears("stop.");
    await world.hears("STOP");

    await expect.poll(world.got, poll).toEqual([confirmation]);
    const kinds = (await world.decisions()).map(({ kind }) => kind);
    expect(kinds).toEqual(["opt_out_confirmation"]);
  });

  it("matches the keywords of the Channel it came on", async () => {
    const world = await instance([quiet()]);

    // "END" is a carrier's keyword on SMS, and only a word elsewhere.
    await world.hears("END", "fake", "+15550003");
    expect((await world.rpc.representative.customerList()).flatMap((c) => c.identities)).toEqual([
      expect.objectContaining({ optedOut: null }),
    ]);

    await world.hears("END", "sms", "+15550004");
    const identities = (await world.rpc.representative.customerList()).flatMap((c) => c.identities);
    expect(identities.filter((each) => each.optedOut)).toEqual([
      expect.objectContaining({ channel: "sms", externalId: "+15550004" }),
    ]);
  });

  it("keeps their messages for the owner and starts no Turn", async () => {
    const world = await instance([]);
    await world.hears("STOP");

    const { jobId } = await world.hears("Why did you stop?");

    expect(jobId).toBeNull();
    expect(world.entered).toEqual([]);
    const { messages } = await world.thread();
    expect(messages.filter(({ author }) => author === "customer").map(({ text }) => text)).toEqual([
      "STOP",
      "Why did you stop?",
    ]);
  });

  it("sends a blocked Customer no confirmation", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const { customer } = await world.thread();
    await world.rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await world.hears("STOP");

    expect(await identity(world)).toMatchObject({ optedOut: { source: "keyword" } });
    expect(world.got()).toEqual([]);
    expect((await world.decisions()).map(({ rule }) => rule)).toEqual(["blocked"]);
  });
});

describe("a draft waiting for a Customer who opts out", () => {
  it("is replaced by their STOP, so nothing is left that could send", async () => {
    const world = await instance([drafts("Our hours are nine to five."), quiet()]);
    await world.hears("When do you open?");
    expect(await world.rpc.representative.replyDraftList()).toHaveLength(1);

    await world.hears("STOP");

    expect(await world.rpc.representative.replyDraftList()).toEqual([]);
    await expect.poll(world.got, poll).toEqual([holdingNote, confirmation]);
  });

  it("is replaced by a Representative's flag too", async () => {
    const world = await instance([
      drafts("Our hours are nine to five."),
      round(toolCall({ name: "flag_opt_out", input: {} })),
      quiet(),
    ]);

    await world.hears("When do you open? And stop texting me.");

    expect(await world.rpc.representative.replyDraftList()).toEqual([]);
    await expect.poll(world.got, poll).toEqual([holdingNote, confirmation]);
  });
});

describe("START and the owner's clearing", () => {
  it("lifts the opt-out when the Customer says START, and the next message gets a Turn", async () => {
    const world = await instance([replies("Welcome back."), quiet()]);
    await world.hears("STOP");

    await world.hears("START");
    expect((await identity(world)).optedOut).toBeNull();
    expect(world.entered).toEqual([]);

    await world.hears("Are you open?");
    await expect.poll(world.got, poll).toEqual([confirmation, "Welcome back."]);
  });

  it("lifts it when the owner clears it from their screens", async () => {
    const world = await instance([]);
    await world.hears("STOP");
    const { customer, identities } = await world.thread();

    const cleared = await world.rpc.representative.customerClearOptOut({
      id: customer.id,
      identityId: identities[0]!.id,
    });

    expect(cleared.identities[0]!.optedOut).toBeNull();
    const answer = await world.reply("Back again");
    expect(answer).toEqual({ sent: true });
    await expect.poll(world.got, poll).toEqual([confirmation, "Back again"]);
  });

  it("refuses the owner's own message to an opted-out Customer, and says why", async () => {
    const world = await instance([]);
    await world.hears("STOP");
    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });

    await expect(world.rpc.representative.threadSend({ id, text: "Hi" })).rejects.toMatchObject({
      data: { code: "error.customerOptedOut" },
    });
  });
});

describe("a Representative's flag", () => {
  it("is offered on a Release that lists only reply, and takes effect at once, with one confirmation", async () => {
    const world = await instance([
      round(toolCall({ name: "flag_opt_out", input: {}, id: "flag" })),
      replies("Sorry to see you go."),
      quiet(),
    ]);

    await world.hears("Please stop texting me");

    const offered = (world.entered[0] as { tools?: { name: string }[] }).tools?.map((t) => t.name);
    expect(offered).toContain("flag_opt_out");

    expect(await identity(world)).toMatchObject({ optedOut: { source: "representative" } });
    await expect.poll(world.got, poll).toEqual([confirmation]);
    expect(
      (await world.decisions()).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    ).toEqual([
      ["opt_out_confirmation", "send", "passed"],
      ["reply", "drop", "optedOut"],
    ]);
  });
});
