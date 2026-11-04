import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
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
import {
  representative,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { liveChecks, passGate } from "../src/server/outbound-gate";
import { representativeFeature } from "../src/server/plugin";
import { handOffMessage } from "../src/server/replies";
import { takeoverNote } from "../src/server/takeover";

/*
 * The Outbound gate (ticket #1298), through the Representative's real reply path: a fake Model on
 * real Postgres, and a Customer channel over `fakeMessagingAdapter`. What a Customer got is what the
 * fake recorded, and why is the decision log.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) =>
  round(toolCall({ name: "reply", input: { text, kind: "small_talk" } }));
/** A reply no source backs: code refuses it. */
const guesses = (text: string) =>
  round(toolCall({ name: "reply", input: { text, kind: "answer" } }));

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A promise a test resolves, which resolves by itself when the test ends. */
function opening() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  onTestFinished(() => open());
  return { opened, open };
}

/** A running instance whose Customer channel sends through a fake messaging adapter. */
async function instance(rounds: Round[], held?: Promise<void>) {
  const fake = createFakeAdapter({ rounds });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      await held;
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
    sendProof: async (to, proof) => {
      const message = { chatId: to.externalId, text: proof.secret };
      await messaging.adapter.send(account, message, { fetch });
    },
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
    draft: { jobText: "Answer questions.", model, tools: ["reply", "verify_customer"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  return {
    messaging,
    entered,
    timer,
    rpc,
    id,
    user,
    deps: world,
    threadId,
    /** A Customer's message on the fake Channel, answered by a Turn that runs to its end. */
    hears: (message: string, proof?: { rule: "codeRoundTrip" }) =>
      testCustomerTurn(world, { representativeId: id, externalId: number, message, proof }),
    /** What reached the Customer, in the order the fake sent it. */
    got: () => messaging.delivered.map(({ part }) => part),
    decisions: async () =>
      getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, await threadId()))
        .orderBy(asc(representativeOutboundDecision.id)),
    liveRelease: async () => {
      const [row] = await getTestDb()
        .select({ liveReleaseId: representative.liveReleaseId })
        .from(representative)
        .where(eq(representative.id, id));
      return row!.liveReleaseId!;
    },
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** A Customer heard, on a thread with nothing sent on it yet. */
const heard = (world: World) => world.hears("Hello");

/** The Representative's reply, as the tool stores it, from a Turn still running. */
const anotherReply = async ({ deps, threadId }: World) => {
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  const id = await threadId();
  return getTestDb().transaction((tx) =>
    storeReply(
      feature.context,
      tx,
      { threadId: id, heard: { channel: "fake", externalId: number }, verified: false },
      { text: "Still here", sources: [] },
      "small_talk",
      new Date(),
    ),
  );
};

describe("a Representative's reply", () => {
  it("reaches the Channel through the real reply path, with a decision naming its Release", async () => {
    const world = await instance([replies("We open at nine."), quiet()]);

    await world.hears("When do you open?");

    await expect.poll(world.got, poll).toEqual(["We open at nine."]);
    expect(world.messaging.sends[0]!.message.chatId).toBe(number);
    const [message] = await getTestDb()
      .select({ id: representativeThreadMessage.id })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.text, "We open at nine."));
    expect(await world.decisions()).toMatchObject([
      {
        kind: "reply",
        outcome: "send",
        rule: "passed",
        releaseId: await world.liveRelease(),
        channel: "fake",
        externalId: number,
        messageId: message!.id,
      },
    ]);
  });

  it("names the Release its Turn started on, not one approved during the Turn", async () => {
    const held = opening();
    const world = await instance([replies("We open at nine."), quiet()], held.opened);
    const first = await world.liveRelease();
    const turn = world.hears("When do you open?");
    await expect.poll(() => world.entered.length, poll).toBe(1);

    await world.rpc.representative.updateDraft({ id: world.id, draft: { jobText: "New job." } });
    await world.rpc.representative.approve({ id: world.id });
    expect(await world.liveRelease()).not.toBe(first);
    held.open();
    await turn;

    expect(await world.decisions()).toMatchObject([{ kind: "reply", releaseId: first }]);
  });

  it("goes again when the Channel fails, and isn't lost", async () => {
    const world = await instance([replies("We open at nine."), quiet()]);
    world.messaging.counts.sendFailures = 1;

    await world.hears("When do you open?");

    await expect
      .poll(() => {
        world.timer.advance(60_000);
        world.timer.tick();
        return world.got();
      }, poll)
      .toEqual(["We open at nine."]);
    expect(await world.decisions()).toHaveLength(1);
  });

  it("is refused while the owner holds the thread, and the takeover note still goes", async () => {
    const world = await instance([quiet()]);
    await heard(world);

    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    expect(await anotherReply(world)).toMatchObject({
      error: expect.stringContaining("nothing was sent"),
    });

    await expect.poll(world.got, poll).toEqual([takeoverNote]);
    expect(await world.decisions()).toMatchObject([
      { kind: "takeover_note", outcome: "send", rule: "passed" },
      { kind: "reply", outcome: "drop", rule: "held", messageId: null },
    ]);
  });

  it("gives a blocked Customer nothing, and says why", async () => {
    const world = await instance([quiet()]);
    await heard(world);

    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });
    expect(await anotherReply(world)).toMatchObject({
      error: expect.stringContaining("nothing was sent"),
    });

    expect(await world.decisions()).toMatchObject([
      { kind: "reply", outcome: "drop", rule: "blocked" },
    ]);
    expect(world.got()).toEqual([]);
  });

  it("doesn't send once its Representative is switched off, and says why", async () => {
    const held = opening();
    const world = await instance([replies("Too late."), quiet()], held.opened);
    const turn = world.hears("Hello");
    await expect.poll(() => world.entered.length, poll).toBe(1);

    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    held.open();
    await turn;

    expect(await world.decisions()).toMatchObject([{ kind: "reply", outcome: "drop", rule: "on" }]);
    expect(world.got()).toEqual([]);
  });
});

describe("every send site", () => {
  it("leaves one decision per send: a reply, the code hand-off, the takeover note and the owner's send", async () => {
    const world = await instance([
      replies("Hi."),
      guesses("Open at nine."),
      guesses("Open at ten."),
      quiet(),
    ]);
    await world.hears("Hello");

    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    await world.rpc.representative.threadSend({ id: await world.threadId(), text: "It's me." });

    await expect.poll(() => world.got().length, poll).toBe(4);
    expect(world.got().toSorted()).toEqual(
      ["Hi.", handOffMessage, takeoverNote, "It's me."].toSorted(),
    );
    const decisions = await world.decisions();
    expect(decisions.map(({ kind, outcome }) => [kind, outcome])).toEqual([
      ["reply", "send"],
      ["code_hand_off", "send"],
      ["takeover_note", "send"],
      ["owner", "send"],
    ]);
    expect(decisions.every(({ releaseId }) => releaseId !== null)).toBe(true);
  });

  it("leaves a decision for a proof, which holds no secret", async () => {
    const world = await instance([
      round(toolCall({ name: "verify_customer", input: {}, id: "verify" })),
      quiet(),
    ]);

    await world.hears("Prove me", { rule: "codeRoundTrip" });

    await expect.poll(() => world.messaging.sends.length, poll).toBe(1);
    const [decision] = await world.decisions();
    expect(decision).toMatchObject({
      kind: "proof",
      outcome: "send",
      rule: "passed",
      releaseId: await world.liveRelease(),
      channel: "fake",
      externalId: number,
      messageId: null,
    });
    const secret = world.messaging.sends[0]!.message.text;
    expect(JSON.stringify(decision)).not.toContain(secret);
  });

  it("drops a blocked Customer's takeover note and the owner's message, each with its reason", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    const [line] = await world.rpc.representative.threadList({ id: world.id });

    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });
    await world.rpc.representative.threadTakeOver({ id: line!.id });
    await expect(
      world.rpc.representative.threadSend({ id: line!.id, text: "It's me." }),
    ).rejects.toThrow("blocked");

    expect(await world.decisions()).toMatchObject([
      { kind: "takeover_note", outcome: "drop", rule: "blocked" },
      { kind: "owner", outcome: "drop", rule: "blocked" },
    ]);
    expect(world.got()).toEqual([]);
  });
});

describe("the gate's order and what it holds", () => {
  const passing = (world: World, id: string, checks: Partial<typeof liveChecks>) =>
    getTestDb().transaction((tx) =>
      passGate(
        tx,
        {
          kind: "reply",
          threadId: id,
          to: { channel: "fake", externalId: number },
          now: world.timer.clock.now(),
          content: { text: "Later, maybe.", verified: true, replyKind: "small_talk", sources: [] },
        },
        { ...liveChecks, ...checks },
      ),
    );

  it("stores a held message and doesn't send it", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    const id = await world.threadId();

    const decision = await passing(world, id, { caps: () => "hold" });

    expect(decision).toMatchObject({ outcome: "hold", rule: "caps" });
    const held = await getTestDb()
      .select()
      .from(representativeHeldMessage)
      .where(eq(representativeHeldMessage.threadId, id));
    expect(held).toMatchObject([
      { decisionId: decision!.id, text: "Later, maybe.", verified: true, replyKind: "small_talk" },
    ]);
    const { messages } = await world.rpc.representative.threadGet({ id });
    expect(messages.map(({ text }) => text)).toEqual(["Hello"]);
    expect(world.got()).toEqual([]);
  });

  it("lets the earlier rule decide when two fail together", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    // Blocked (rule 2) before caps (rule 5): dropped, not held.
    expect(await passing(world, line!.id, { caps: () => "hold" })).toMatchObject({
      outcome: "drop",
      rule: "blocked",
    });
    // Held (rule 1) before blocked (rule 2).
    await world.rpc.representative.threadTakeOver({ id: line!.id });
    expect(await passing(world, line!.id, {})).toMatchObject({ outcome: "drop", rule: "held" });
  });

  it("passes the takeover note past a rule it doesn't list", async () => {
    const world = await instance([quiet()]);
    await heard(world);

    // The note goes whatever the Representative's switch says.
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });

    await expect.poll(world.got, poll).toEqual([takeoverNote]);
  });
});

describe("a test conversation", () => {
  it("reaches no Channel and logs no thread", async () => {
    const world = await instance([replies("Hi."), quiet()]);
    await world.rpc.representative.updateDraft({
      id: world.id,
      draft: {
        tests: [{ name: "Greets", message: "Say hi", expect: [{ kind: "replied" }] }],
      },
    });

    await world.rpc.representative.runTests({ id: world.id });
    await expect
      .poll(async () => {
        const { tests, testStatus } = await world.rpc.representative.get({ id: world.id });
        return tests.every(({ status }) => status !== "queued" && status !== "running")
          ? testStatus
          : null;
      }, poll)
      .toMatch(/^(passed|failed)$/);

    expect(world.messaging.sends).toEqual([]);
    expect(await world.rpc.representative.threadList({ id: world.id })).toEqual([]);
  });
});

describe("the owner's export", () => {
  it("holds each decision", async () => {
    const world = await instance([replies("Hi."), quiet()]);
    await heard(world);

    const exported = (await exportUserData(world.deps, world.user.id)) as unknown as {
      representative: {
        outboundDecisions: Array<{ kind: string; outcome: string; rule: string }>;
      };
    };

    expect(exported.representative.outboundDecisions).toMatchObject([
      { kind: "reply", outcome: "send", rule: "passed" },
    ]);
  });
});
