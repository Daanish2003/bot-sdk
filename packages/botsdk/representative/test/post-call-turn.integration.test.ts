import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessagingReach } from "@botsdk/bot/channel";
import { toNodeHandler } from "@botsdk/bot/http";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { encryptCredentials } from "@botsdk/bot/credentials/encryption";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment, channelAccount, job, page } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { autoSource, promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, runError, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { type CustomerChannel, noCustomerChannel } from "../src/server/customer-proof";
import {
  representative,
  representativeChannelAccount,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { inboundLimit } from "../src/server/inbound-limit";
import { representativeFeature } from "../src/server/plugin";
import { waitingElsewhere } from "../src/server/reply-drafts";
import { capReached } from "../src/server/spending";
import { turnStepLimit } from "../src/server/turn";
import { callEndDueMs } from "../src/server/call-lost";
import { receiveCustomerMessage } from "../src/server/thread-turns";
import { voice } from "../src/server/voice-adapter";

/*
 * The Turn after a Call (ticket #1385, ADR 0036): over the voice hooks on real HTTP and real Postgres,
 * with a fake Model. A `call` entry wakes a normal Turn, and for the counters it is a Customer's word.
 * The clock is pinned to midday UTC, so quiet hours never decide one of these by the hour they run at.
 */

vi.setConfig({ testTimeout: 30_000 });

const key = "key-a-of-at-least-32-characters-long!!";
const basePath = "/api/chat";
const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const caller = "+15550002";
const number = "+15551234567";
const noon = new Date("2026-11-09T12:00:00Z");
const smsReach: MessagingReach = {
  canStartConversation: false,
  maxLength: 459,
  cutsLongMessages: true,
};

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const quiet = () => round();
const replyCall = (text: string, id?: string, topic = "general") =>
  toolCall({
    name: "reply",
    input: { topic, sources: [autoSource], text, kind: "small_talk" },
    ...(id && { id }),
  });
const replies = (text: string) => round(replyCall(text));
const handsOff = (instructions: string) =>
  round(toolCall({ name: "hand_to_bot", input: { title: "A callback", instructions } }));

const said = [
  { role: "agent", text: "Hello, thanks for calling." },
  { role: "caller", text: "My AC is broken." },
];

const servers: Server[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A served owner whose enabled Representative holds a voice account and reports to a Bot. Texts go to a
 * recording Channel, or with `accounts` through the accounts the Representative really holds.
 */
async function world(
  rounds: Rounds = [],
  {
    accounts = false,
    reach = smsReach,
    beforeModel,
  }: {
    accounts?: boolean;
    reach?: MessagingReach;
    /** Runs as each Model call starts, so a Call can end during a Turn. */
    beforeModel?: () => Promise<void>;
  } = {},
) {
  const fake = createFakeAdapter({ rounds });
  const representativeAdapter: AnyTextAdapter = {
    ...(fake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      await beforeModel?.();
      yield* fake.adapter.chatStream(options);
    },
  };
  const botFake = createFakeAdapter({ rounds: [round(), round(), round()] });
  const timer = fakeJobClock(noon);
  const texts: string[] = [];
  const recording: CustomerChannel = {
    send: async (_to, { text }) => {
      texts.push(text);
    },
    sendProof: async () => {},
    reach: () => reach,
  };
  const messaging = fakeMessagingAdapter({ id: "sms" });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    channels: [voice(), messaging.adapter],
    features: [representativeFeature({}, accounts ? undefined : recording)],
    adapterFor: (id) =>
      id === botModel ? (botFake.adapter as AnyTextAdapter) : representativeAdapter,
    clock: timer.clock.now,
    keyEncryptionSecrets: [key],
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "...-key",
    verified: true,
  });
  const server = createServer(
    toNodeHandler(createHttpHandlerOver(deps, { basePath, getUser: () => null })),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;

  const rpc = chatRpc({ user, deps });
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "hand_to_bot"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  const connected = await rpc.representative.voiceAccountConnect({ id, number });
  const accountId = connected.view.accounts[0]!.id;
  const context = {
    ...deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    channel: noCustomerChannel,
  };

  const hook = (name: string, body: unknown) =>
    fetch(`${url}/representative/voice/${accountId}/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connected.secret}`,
      },
      body: JSON.stringify(body),
    });
  const callStarts = async (callId = "call-1") =>
    (await hook("start", { callId, caller })).json() as Promise<{ decision: string }>;
  const callEnds = async (callId = "call-1") => {
    expect((await hook("end", { callId, transcript: said })).status).toBe(200);
  };
  const calls = async (callId = "call-1") => {
    expect(await callStarts(callId)).toMatchObject({ decision: "answer" });
    await callEnds(callId);
  };
  const text = (message: string, proof?: { rule: "sameIdentity" }) =>
    receiveCustomerMessage(context, {
      representativeId: id,
      channel: "sms",
      externalId: caller,
      message,
      proof,
    });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  const entries = async () =>
    getTestDb()
      .select()
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, await threadId()))
      .orderBy(asc(representativeThreadMessage.position));
  const decisions = async () =>
    (
      await getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, await threadId()))
        .orderBy(asc(representativeOutboundDecision.id))
    ).map((row) => [row.kind, row.outcome, row.rule]);
  const turns = async () =>
    getTestDb().select().from(job).where(eq(job.name, "representative.turn"));
  const threadRow = async () =>
    (
      await getTestDb()
        .select()
        .from(representativeThread)
        .where(eq(representativeThread.id, await threadId()))
    )[0]!;
  const assignments = () =>
    getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId));
  /** Runs what came due, as the batch window closes on the fake clock. */
  const settle = async (ms = 60_000) => {
    timer.advance(ms);
    await expect
      .poll(
        async () => {
          timer.tick();
          const rows = await getTestDb()
            .select({ status: job.status, runAfter: job.runAfter })
            .from(job);
          return rows.filter(
            (row) =>
              ["queued", "running"].includes(row.status) && row.runAfter <= timer.clock.now(),
          ).length;
        },
        { timeout: 15_000 },
      )
      .toBe(0);
  };
  return {
    rpc,
    id,
    user,
    fake,
    timer,
    texts,
    messaging,
    hook,
    callStarts,
    callEnds,
    calls,
    text,
    threadId,
    entries,
    decisions,
    turns,
    threadRow,
    assignments,
    settle,
  };
}

/** An SMS account the Representative holds on `smsNumber`, as the database has it. */
async function holdSms(representativeId: string, smsNumber: string) {
  const accountId = uuidv7();
  const now = new Date();
  await getTestDb().transaction(async (tx) => {
    await tx.insert(channelAccount).values({
      id: accountId,
      botId: null,
      platform: "sms",
      platformBotId: smsNumber,
      handle: smsNumber,
      encrypted: encryptCredentials(
        { token: "1:secret" },
        { secrets: [key], kind: "channel", context: `${accountId}:sms` },
      ),
      status: "active",
      reason: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .insert(representativeChannelAccount)
      .values({ channelAccountId: accountId, representativeId });
  });
}

describe("the Turn a finished Call wakes", () => {
  it("is one, when the end is delivered twice", async () => {
    const { calls, callEnds, settle, fake, turns } = await world([quiet]);

    await calls();
    await callEnds();
    await settle();

    expect(await turns()).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("reads the transcript, the recorded requests and that it may be mis-heard", async () => {
    const { callStarts, callEnds, hook, settle, fake } = await world([quiet]);
    await callStarts();
    await hook("request", {
      callId: "call-1",
      request: "Send a technician on Tuesday",
      callback: "after 3pm",
      emergency: false,
    });
    await callEnds();

    await settle();

    const prompt = JSON.stringify(fake.calls[0]!.messages);
    expect(prompt).toContain("Caller: My AC is broken.");
    expect(prompt).toContain("Send a technician on Tuesday");
    expect(prompt).toContain("after 3pm");
    expect(prompt).toMatch(/voice agent's model[^"]*may be mis-heard/);
    expect(prompt).toContain("The phone call above has finished");
  });

  it("can end with nothing sent, and code neither texts them nor makes work of it", async () => {
    const { calls, settle, texts, entries, assignments, threadRow } = await world([quiet]);

    await calls();
    await settle();

    expect(texts).toEqual([]);
    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect(await assignments()).toEqual([]);
    expect((await threadRow()).turnId).toBeNull();
  });

  it("can hand a recorded request to the Bot", async () => {
    const { callStarts, callEnds, hook, settle, assignments } = await world([
      handsOff("Book the technician for Tuesday."),
      quiet,
    ]);
    await callStarts();
    await hook("request", { callId: "call-1", request: "A technician", emergency: false });
    await callEnds();

    await settle();

    expect(await assignments()).toMatchObject([
      { instructions: expect.stringContaining("Book the technician for Tuesday.") },
    ]);
  });

  it("is an unverified sender's, so nothing of the Customer's verified past reaches it", async () => {
    const { text, settle, calls, fake } = await world([replies("Noted"), quiet, quiet]);
    await text("My gate code is 4471, I'm at 12 Elm Street.", { rule: "sameIdentity" });
    await settle();
    expect(JSON.stringify(fake.calls[0]!.messages)).toContain("4471");

    await calls();
    await settle();

    const prompt = JSON.stringify(fake.calls.at(-1)!.messages);
    expect(prompt).toContain("Caller: My AC is broken.");
    expect(prompt).not.toContain("4471");
    expect(prompt).not.toContain("Elm Street");
    expect(prompt).toContain("isn't verified");
  });

  it("ends its prompt on a Call that came during the last Turn, after that Turn's reply", async () => {
    let during: (() => Promise<void>) | undefined;
    const { text, callStarts, callEnds, settle, fake } = await world(
      [replies("Hi there"), quiet, quiet],
      {
        beforeModel: async () => {
          const go = during;
          during = undefined;
          await go?.();
        },
      },
    );
    await callStarts();
    during = () => callEnds();
    await text("Hello");

    await settle();
    await settle();

    const prompt = JSON.stringify(fake.calls.at(-1)!.messages);
    expect(prompt.indexOf("Caller: My AC is broken.")).toBeGreaterThan(prompt.indexOf("Hi there"));
  });

  it("doesn't start for a blocked caller", async () => {
    const { callStarts, callEnds, turns, threadRow, entries } = await world();
    await callStarts();
    await getTestDb()
      .update(representativeCustomer)
      .set({ blockedAt: noon })
      .where(eq(representativeCustomer.id, (await threadRow()).customerId));

    await callEnds();

    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect(await turns()).toEqual([]);
  });

  it("doesn't start for a caller who opted out", async () => {
    const { callStarts, callEnds, turns, entries } = await world();
    await callStarts();
    await getTestDb()
      .update(representativeCustomerIdentity)
      .set({ optedOutAt: noon })
      .where(eq(representativeCustomerIdentity.externalId, caller));

    await callEnds();

    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect(await turns()).toEqual([]);
  });

  it("runs on a thread at a limit, while the Call is fresh", async () => {
    const { callStarts, callEnds, threadId, settle, fake } = await world([quiet]);
    await callStarts();
    await getTestDb()
      .update(representativeThread)
      .set({ limitNotedAt: noon })
      .where(eq(representativeThread.id, await threadId()));

    await callEnds();
    await settle();

    expect(fake.calls).toHaveLength(1);
  });

  it("failing, still gets the Call to the Bot, requests first, though no text can go", async () => {
    const { callStarts, hook, settle, entries, assignments, turns, threadRow, decisions } =
      await world(
        Array.from({ length: 10 }, () => round(runError("The Provider is down"))),
        { accounts: true },
      );
    await callStarts();
    await hook("request", {
      callId: "call-1",
      request: "Call me about my refund",
      emergency: false,
    });
    await hook("end", {
      callId: "call-1",
      transcript: [{ role: "caller", text: "a".repeat(4_000) }],
    });

    for (let tries = 0; tries < 6; tries++) await settle(3_600_000);

    expect((await turns()).map((turn) => turn.status)).toEqual(["failed"]);
    await expect.poll(async () => (await threadRow()).turnId, { timeout: 10_000 }).toBeNull();
    expect(await decisions()).toEqual([["code_hand_off", "drop", "channel"]]);
    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect(await assignments()).toMatchObject([
      { instructions: expect.stringContaining("Call me about my refund") },
    ]);
  });

  it("that runs out of Steps still gets the Call to the Bot", async () => {
    const { calls, settle, assignments } = await world(
      Array.from({ length: turnStepLimit + 2 }, (_, index) =>
        round(replyCall("Following up.", `reply-${index}`)),
      ),
      { accounts: true },
    );

    await calls();
    await settle();

    expect(await assignments()).toHaveLength(1);
  });

  it("is woken by a Call that never ended, whose requests it reads once", async () => {
    const { callStarts, hook, settle, fake, entries } = await world([quiet]);
    await callStarts();
    await hook("request", {
      callId: "call-1",
      request: "Call me about my refund",
      emergency: false,
    });

    await settle(callEndDueMs + 1_000);
    await settle();

    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect(fake.calls).toHaveLength(1);
    const prompt = JSON.stringify(fake.calls[0]!.messages);
    expect(prompt).toContain("The call ended without a transcript.");
    expect(prompt.split("Call me about my refund")).toHaveLength(2);
  });

  it("passes the Call on to the Bot with a text code hands off", async () => {
    const { text, callStarts, callEnds, settle, assignments } = await world([quiet]);
    await callStarts();
    await text("Hello");
    await callEnds();

    await settle();

    expect(await assignments()).toMatchObject([
      { instructions: expect.stringContaining("Caller: My AC is broken.") },
    ]);
  });

  it("answers apart from a verified text that waits with it", async () => {
    const { text, calls, settle, fake } = await world([quiet, quiet]);
    await text("Please check my account", { rule: "sameIdentity" });
    await calls();

    await settle();
    await settle();

    expect(fake.calls).toHaveLength(2);
    const [first, second] = fake.calls.map((call) => JSON.stringify(call.messages));
    expect(first).toContain("Please check my account");
    expect(first).not.toContain("My AC is broken.");
    expect(first).not.toContain("The phone call above has finished");
    expect(second).toContain("My AC is broken.");
    expect(second).toContain("isn't verified");
  });
});

describe("the follow-up text", () => {
  it("passes the gate as Customer-started, even after 5 texts in a row", async () => {
    const { text, settle, calls, decisions, texts } = await world([
      round(
        replyCall("one", "reply-1"),
        replyCall("two", "reply-2"),
        replyCall("three", "reply-3"),
        replyCall("four", "reply-4"),
        replyCall("five", "reply-5"),
      ),
      quiet,
      replies("Following up on your call."),
      quiet,
    ]);
    await text("Hello");
    await settle();
    expect((await decisions()).filter(([, outcome]) => outcome === "send")).toHaveLength(5);

    await calls();
    await settle();

    expect((await decisions()).at(-1)).toEqual(["reply", "send", "passed"]);
    await expect.poll(() => texts.at(-1), { timeout: 10_000 }).toBe("Following up on your call.");
  });

  it("passes a Channel's reply window, from the Call", async () => {
    const { calls, settle, decisions } = await world([replies("Following up."), quiet], {
      reach: { replyWindowHours: 24 },
    });

    await calls();
    await settle();

    expect(await decisions()).toEqual([["reply", "send", "passed"]]);
  });

  it("isn't sent with no SMS account, and the Turn ends cleanly", async () => {
    const { calls, settle, decisions, entries, threadRow, turns } = await world(
      [replies("Following up."), quiet],
      { accounts: true },
    );

    await calls();
    await settle();

    expect(await decisions()).toEqual([["reply", "drop", "channel"]]);
    expect((await entries()).map((entry) => entry.author)).toEqual(["call"]);
    expect((await threadRow()).turnId).toBeNull();
    expect((await turns()).map((turn) => turn.status)).toEqual(["succeeded"]);
  });

  it("is dropped rather than held for the owner when a cap is reached and no account can send it", async () => {
    const { rpc, id, threadId, callStarts, callEnds, settle, decisions } = await world(
      [replies("Following up."), quiet],
      { accounts: true },
    );
    await rpc.representative.setCaps({ id, maxPerDay: 1 });
    await callStarts();
    await getTestDb()
      .insert(representativeOutboundDecision)
      .values({
        id: uuidv7(),
        threadId: await threadId(),
        kind: "reply",
        outcome: "send",
        rule: "passed",
        channel: "sms",
        externalId: caller,
        createdAt: noon,
      });
    await callEnds();
    await settle();

    expect((await decisions()).at(-1)).toEqual(["reply", "drop", "channel"]);
  });

  it("goes through the SMS account when the Representative holds one", async () => {
    const { id, calls, settle, decisions, messaging } = await world(
      [replies("Following up."), quiet],
      { accounts: true },
    );
    await holdSms(id, number);

    await calls();
    await settle();

    expect(await decisions()).toEqual([["reply", "send", "passed"]]);
    await expect
      .poll(() => messaging.delivered.map(({ part }) => part), { timeout: 10_000 })
      .toEqual(["Following up."]);
  });

  it("counts toward the daily cap as any text does, and the Call doesn't", async () => {
    const { rpc, id, text, settle, calls, decisions } = await world([
      replies("First"),
      quiet,
      replies("After the first call"),
      quiet,
      replies("After the second call"),
      quiet,
    ]);
    await rpc.representative.setCaps({ id, maxPerDay: 2 });
    await text("Hello");
    await settle();

    await calls("call-1");
    await settle();
    expect((await decisions()).at(-1)).toEqual(["reply", "send", "passed"]);

    await calls("call-2");
    await settle();
    expect((await decisions()).at(-1)).toEqual(["reply", "hold", "caps"]);
  });
});

describe("a taken-over thread", () => {
  it("gets no Turn, and the entry is held for the owner", async () => {
    const { rpc, callStarts, callEnds, threadId, settle, fake, entries, threadRow } = await world();
    await callStarts();
    await rpc.representative.threadTakeOver({ id: await threadId() });

    await callEnds();
    await settle();

    expect(fake.calls).toHaveLength(0);
    expect((await entries()).find((entry) => entry.author === "call")).toMatchObject({
      heldForOwner: true,
    });
    expect((await threadRow()).waitingFrom).toBeNull();
  });

  it("gets no Turn when handed back either: the owner has the entry", async () => {
    const { rpc, callStarts, callEnds, threadId, settle, fake } = await world();
    await callStarts();
    const id = await threadId();
    await rpc.representative.threadTakeOver({ id });
    await callEnds();

    await rpc.representative.threadHandBack({ id });
    await settle();

    expect(fake.calls).toHaveLength(0);
  });

  it("Pages the owner when the caller has waited two hours", async () => {
    const { rpc, callStarts, callEnds, threadId, settle } = await world();
    await callStarts();
    await rpc.representative.threadTakeOver({ id: await threadId() });
    await callEnds();

    await settle(2 * 60 * 60_000 + 1_000);

    expect((await rpc.pages.list()).map(({ cause }) => cause)).toEqual(["owner_wait"]);
  });
});

describe("for the counters a Call is the Customer's word", () => {
  it("reaches the inbound limit, and the next Call is declined", async () => {
    const { callStarts, callEnds, threadId } = await world();
    await callStarts("call-0");
    const id = await threadId();
    await getTestDb()
      .insert(representativeThreadMessage)
      .values(
        Array.from({ length: inboundLimit - 1 }, (_, index) => ({
          id: uuidv7(),
          threadId: id,
          position: index + 1,
          author: "call" as const,
          text: "Caller: Hello",
          verified: false,
          channel: "sms",
          externalId: caller,
          createdAt: noon,
        })),
      );
    await getTestDb()
      .update(representativeThread)
      .set({ messageCount: inboundLimit - 1 })
      .where(eq(representativeThread.id, id));

    expect(await callStarts("call-1")).toMatchObject({ decision: "answer" });
    await callEnds("call-0");

    expect(await callStarts("call-2")).toMatchObject({ decision: "decline" });
  });

  it("replaces a draft waiting for that caller, as a text would", async () => {
    const { text, settle, calls } = await world([
      round(replyCall("Probably Tuesday", undefined, "scheduling")),
      quiet,
    ]);
    await text("When can you come?");
    await settle();
    const [draft] = await getTestDb().select().from(representativeHeldMessage);
    expect(draft!.resolution).toBeNull();

    await calls();

    const [replaced] = await getTestDb().select().from(representativeHeldMessage);
    expect(replaced!.resolution).toBe("replaced");
  });

  it("outdates a draft whose Turn it came during", async () => {
    let during: (() => Promise<void>) | undefined;
    const { text, callStarts, callEnds, settle } = await world(
      [round(replyCall("Probably Tuesday", undefined, "scheduling")), quiet, quiet],
      {
        beforeModel: async () => {
          const go = during;
          during = undefined;
          await go?.();
        },
      },
    );
    await callStarts();
    during = () => callEnds();
    await text("When can you come?");

    await settle();

    const [draft] = await getTestDb().select().from(representativeHeldMessage);
    expect(draft!.resolution).toBe("replaced");
  });

  it("makes the next draft's holding note due again", async () => {
    const { text, settle, calls, decisions } = await world([
      round(replyCall("Probably Tuesday", undefined, "scheduling")),
      quiet,
      round(replyCall("Tuesday it is", undefined, "scheduling")),
      quiet,
    ]);
    await text("When can you come?");
    await settle();

    await calls();
    await settle();

    expect((await decisions()).filter(([kind]) => kind === "holding_note")).toEqual([
      ["holding_note", "send", "passed"],
      ["holding_note", "send", "passed"],
    ]);
  });

  it("waits apart from another sender's", async () => {
    const { callStarts, callEnds, threadId } = await world();
    await callStarts();
    await callEnds();
    const id = await threadId();

    const elsewhere = await getTestDb().transaction((tx) =>
      waitingElsewhere(tx, id, 1, { channel: "sms", externalId: "+15559999" }),
    );

    expect(elsewhere).toBe(1);
  });

  it("makes the Customer a stranger for the spending caps", async () => {
    const { id, text, calls, threadId, timer } = await world();
    await getTestDb()
      .update(representative)
      .set({ spendingCaps: sql`'{"customerCalls":0,"strangerCalls":0}'::jsonb` })
      .where(eq(representative.id, id));
    await text("Hello", { rule: "sameIdentity" });
    expect(await capReached(getTestDb(), await threadId(), timer.clock.now())).toBe("customer_cap");

    await calls();

    expect(await capReached(getTestDb(), await threadId(), timer.clock.now())).toBe("stranger_cap");
  });

  it("starts a new run of hand-offs", async () => {
    const { callStarts, callEnds, threadId, settle, assignments } = await world([
      handsOff("Call them back."),
      quiet,
    ]);
    await callStarts();
    const id = await threadId();
    await getTestDb()
      .insert(representativeThreadMessage)
      .values(
        [1, 2, 3].map((position) => ({
          id: uuidv7(),
          threadId: id,
          position,
          author: "bot" as const,
          text: "Done.",
          verified: false,
          assignmentId: uuidv7(),
          channel: "sms",
          externalId: caller,
          createdAt: noon,
        })),
      );
    await getTestDb()
      .update(representativeThread)
      .set({ messageCount: 3 })
      .where(eq(representativeThread.id, id));

    await callEnds();
    await settle();

    expect(await assignments()).toHaveLength(1);
  });

  it("keeps a note sent to a number only ever heard on a Call readable to that number", async () => {
    const { rpc, calls, threadId, entries } = await world();
    await calls();

    await rpc.representative.threadTakeOver({ id: await threadId() });

    expect((await entries()).find((entry) => entry.author === "note")).toMatchObject({
      verified: false,
    });
  });
});

describe("flagging a Call", () => {
  const flags = (what: string, id = "flag") => toolCall({ name: "flag_call", input: { what }, id });
  const pages = () => getTestDb().select().from(page);
  const offered = (call: { tools?: { name: string }[] }) => call.tools?.map((tool) => tool.name);

  it("Pages the owner with what went wrong, and sends the Customer nothing", async () => {
    const { calls, settle, texts, threadId, id, user } = await world([
      round(flags("The agent promised a $50 price no fact supports.")),
      quiet,
    ]);

    await calls();
    await settle();

    expect(await pages()).toMatchObject([
      {
        userId: user.id,
        urgency: "routine",
        text: expect.stringContaining("The agent promised a $50 price no fact supports."),
        path: `/representatives/${id}`,
      },
    ]);
    expect((await pages())[0]!.text).toContain(await threadId());
    expect(texts).toEqual([]);
  });

  it("Pages nobody for a clean Call", async () => {
    const { calls, settle } = await world([quiet]);

    await calls();
    await settle();

    expect(await pages()).toEqual([]);
  });

  it("Pages at most once for one Call, however often it flags", async () => {
    const { calls, settle } = await world([
      round(flags("First thing.", "one"), flags("Second thing.", "two")),
      round(flags("Third thing.", "three")),
      quiet,
    ]);

    await calls();
    await settle();

    expect(await pages()).toHaveLength(1);
  });

  it("Pages once for each Call", async () => {
    const { calls, settle } = await world([
      round(flags("Bad first Call.")),
      quiet,
      round(flags("Bad second Call.")),
      quiet,
    ]);
    await calls("call-1");
    await settle();

    await calls("call-2");
    await settle();

    expect(await pages()).toHaveLength(2);
  });

  it("is offered on the Turn a Call wakes and not on an ordinary text Turn", async () => {
    const { calls, text, settle, fake } = await world([quiet, quiet]);

    await text("Hello");
    await settle();
    await calls();
    await settle();

    expect(fake.calls).toHaveLength(2);
    expect(offered(fake.calls[0] as never)).not.toContain("flag_call");
    expect(offered(fake.calls[1] as never)).toContain("flag_call");
  });
});
