import type { AnyTextAdapter } from "@tanstack/ai";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessagingReach } from "@botsdk/bot/channel";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { quotaLookup, saveCredentials, type HostProvider } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { page, usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  autoSource,
  promoteAutoTopic,
  testCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { requestProof, type CustomerChannel } from "../src/server/customer-proof";
import { storeReply } from "../src/server/customers";
import {
  type OutboundKind,
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeFact,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
  representativeTopic,
} from "../src/server/db/schema";
import { gateOrder, passGate, type GateRule } from "../src/server/outbound-gate";
import { representativeFeature } from "../src/server/plugin";
import { receiveCustomerMessage } from "../src/server/thread-turns";
import { handOffMessage } from "../src/server/replies";
import { takeoverNote } from "../src/server/takeover";

/*
 * The Outbound gate as a whole (ticket #1314): its rules in their fixed order, each message's row of the
 * rules table (ticket #1298), and the overrides, with real state in Postgres and what reached the
 * Customer read from `fakeMessagingAdapter`. Every clock is pinned, so a test holds at any hour.
 */

vi.setConfig({ testTimeout: 30_000 });

const poll = { timeout: 10_000 };
const number = "+15550001";
const here = { channel: "fake", externalId: number };
const model = "openai:gpt-6-luna";
const spentModel = "anthropic:claude-sonnet-5-5";
const script = "Call 112, or leave the building now.";
/** 12:00 UTC: inside the Representative's day, outside its default quiet hours (21:00 to 08:00). */
const day = new Date("2026-11-04T12:00:00Z");
/** 23:00 UTC: inside them. */
const night = new Date("2026-11-04T23:00:00Z");

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The spec's order, written out here and not read from the gate, so moving a rule turns a test red. */
const order: readonly GateRule[] = [
  "held",
  "blocked",
  "optedOut",
  "on",
  "caps",
  "quietHours",
  "channel",
  "topic",
];

const quiet = () => round();
/** A reply with no label, which the gate holds as a Reply draft. */
const drafts = (text: string) =>
  round(toolCall({ name: "reply", input: { text, kind: "small_talk" } }));
const guesses = (text: string) =>
  round(toolCall({ name: "reply", input: { topic: "general", text, kind: "answer" } }));

const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/**
 * A running instance at `at` whose Customer channel sends through a fake messaging adapter. `spent`
 * has the owner's Quota spent, as a Host would see it.
 */
async function instance(
  rounds: Round[],
  { at = day, reach, spent = false }: { at?: Date; reach?: MessagingReach; spent?: boolean } = {},
) {
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
    sendProof: async (to, proof) => {
      await messaging.adapter.send(
        account,
        { chatId: to.externalId, text: proof.secret },
        { fetch },
      );
    },
    reach: () => reach,
  };
  const quota = { budgetUsd: 100, window: "month" as const };
  const timer = fakeJobClock(at);
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
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
    ...(spent && { hostProviders, getQuota: quotaLookup(() => quota) }),
  });
  made = deps;
  await jobs.start();
  runners.push(jobs);

  const user = await insertUser();
  if (!spent) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model: spent ? spentModel : model,
      tools: ["reply", "verify_customer"],
      emergencyText: script,
      emergencyKeywords: ["fire"],
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  if (spent) {
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "representative",
      model: spentModel,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: new Date(),
    });
    quota.budgetUsd = 1;
  }
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  return {
    channel,
    messaging,
    entered,
    timer,
    rpc,
    id,
    user,
    deps: world,
    threadId,
    hears: (message: string) =>
      testCustomerTurn(world, { representativeId: id, externalId: number, message }),
    /** A message by the Channel itself, whose limits `hears` leaves out. */
    arrives: (message: string) =>
      receiveCustomerMessage(
        {
          ...deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
          channel,
        },
        { representativeId: id, channel: "fake", externalId: number, message },
      ),
    /** What reached the Customer, in the order the fake sent it. */
    got: () => messaging.delivered.map(({ part }) => part),
    decisions: async () =>
      getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, await threadId()))
        .orderBy(asc(representativeOutboundDecision.id)),
    context: () =>
      deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** The Representative's reply, as the reply tool stores it, from a Turn still running. */
async function reply(
  world: World,
  {
    now = day,
    businessStarted = false,
    topic = "general",
    sources = [autoSource],
    text = "Still here",
  }: {
    now?: Date;
    businessStarted?: boolean;
    topic?: string;
    sources?: Parameters<typeof storeReply>[3]["sources"];
    text?: string;
  } = {},
) {
  const threadId = await world.threadId();
  return getTestDb().transaction((tx) =>
    storeReply(
      { ...world.context(), channel: world.channel },
      tx,
      { threadId, upTo: 1, heard: here, verified: false, businessStarted },
      { text, sources, topic },
      "small_talk",
      now,
    ),
  );
}

/** A Customer heard, and nothing sent on its thread yet. */
async function heardWorld(options?: Parameters<typeof instance>[1]) {
  const world = await instance([quiet()], options);
  await world.hears("Hello");
  return world;
}

/*
 * What it takes to make each rule fail on its own: rows in the database for four, and a situation (the
 * time, who started the message, the Channel and what the reply rests on) for the other four.
 */
const db = () => getTestDb();
const failsWith: Partial<Record<GateRule, (threadId: string) => Promise<unknown>>> = {
  held: (threadId) =>
    db()
      .update(representativeThread)
      .set({ state: "owner" })
      .where(eq(representativeThread.id, threadId)),
  blocked: async (threadId) => {
    const [row] = await db()
      .select({ customerId: representativeThread.customerId })
      .from(representativeThread)
      .where(eq(representativeThread.id, threadId));
    return db()
      .update(representativeCustomer)
      .set({ blockedAt: day })
      .where(eq(representativeCustomer.id, row!.customerId));
  },
  optedOut: () =>
    db()
      .update(representativeCustomerIdentity)
      .set({ optedOutAt: day })
      .where(
        and(
          eq(representativeCustomerIdentity.channel, here.channel),
          eq(representativeCustomerIdentity.externalId, here.externalId),
        ),
      ),
  on: () => db().update(representative).set({ enabled: false }),
  // No room for any message in a row.
  caps: () => db().update(representative).set({ maxInARow: 0 }),
};
const reachOf = (failing: readonly GateRule[]): MessagingReach | undefined =>
  failing.includes("channel") ? { maxLength: 3 } : undefined;
const situationOf = (failing: readonly GateRule[]) => ({
  now: failing.includes("quietHours") ? night : day,
  businessStarted: failing.includes("quietHours"),
  ...(failing.includes("topic") && { topic: "pricing", sources: [] }),
});
async function breakRows(world: World, failing: readonly GateRule[]) {
  const threadId = await world.threadId();
  for (const rule of failing) await failsWith[rule]?.(threadId);
}

describe("two rules failing together", () => {
  const pairs = order.slice(1).map((later, at) => [order[at]!, later] as const);

  it.each(pairs)("%s decides before %s", async (earlier, later) => {
    const failing = [earlier, later];
    const world = await heardWorld({ reach: reachOf(failing) });
    await breakRows(world, failing);

    const result = await reply(world, situationOf(failing));

    expect(result).not.toEqual({ sent: true });
    const decisions = await world.decisions();
    expect(decisions.at(-1)).toMatchObject({ kind: "reply", rule: earlier, messageId: null });
    expect(decisions).toHaveLength(1);
    expect(world.got()).toEqual([]);
  });

  it("is the order the spec names", () => {
    expect([...gateOrder]).toEqual([...order]);
  });

  it("leaves a decision of the earlier rule's outcome: a drop for the owner's rules, a hold for the limits", async () => {
    const dropped = await heardWorld();
    await breakRows(dropped, ["on", "caps"]);
    await reply(dropped);
    expect((await dropped.decisions()).at(-1)).toMatchObject({ outcome: "drop", rule: "on" });
    expect(await db().select().from(representativeHeldMessage)).toEqual([]);

    // A limit holds: the words wait for the owner.
    const held = await heardWorld();
    await breakRows(held, ["caps", "quietHours"]);
    await reply(held, situationOf(["caps", "quietHours"]));
    expect((await held.decisions()).at(-1)).toMatchObject({ outcome: "hold", rule: "caps" });
    expect(await db().select().from(representativeHeldMessage)).toMatchObject([
      { text: "Still here" },
    ]);
  });
});

describe("what each message passes", () => {
  // The rules table of ticket #1298, written out here and not read from the gate.
  const table: Record<string, { kind: OutboundKind; passes: readonly GateRule[] }> = {
    "a Representative reply": { kind: "reply", passes: order },
    "the owner's own send": { kind: "owner", passes: ["blocked", "optedOut", "channel"] },
    "the takeover note": { kind: "takeover_note", passes: ["blocked", "optedOut", "channel"] },
    "the code hand-off message": {
      kind: "code_hand_off",
      passes: ["held", "blocked", "optedOut", "on", "channel"],
    },
    "the limit note": {
      kind: "limit_note",
      passes: ["held", "blocked", "optedOut", "on", "channel"],
    },
    // The business speaking unprompted, after a silence: quiet hours hold it.
    "the stall holding note": {
      kind: "stall_note",
      passes: ["held", "blocked", "optedOut", "on", "quietHours", "channel"],
    },
    "the draft holding note": {
      kind: "holding_note",
      passes: ["held", "blocked", "optedOut", "on", "channel"],
    },
    "a proof code or link": { kind: "proof", passes: ["blocked", "optedOut", "channel"] },
    "the opt-out confirmation": { kind: "opt_out_confirmation", passes: ["blocked", "channel"] },
    "the emergency script": { kind: "emergency_script", passes: ["blocked", "channel"] },
  };

  // The owner's rules drop what they stop and the limits hold it, except that a Channel's limits hold
  // only what can't go stale and is the Representative's: a reply, the hand-off and the emergency script.
  const outcomeOf = (kind: OutboundKind, rule: GateRule) =>
    ["caps", "quietHours", "topic"].includes(rule) ||
    (rule === "channel" && ["reply", "code_hand_off", "emergency_script"].includes(kind))
      ? "hold"
      : "drop";

  it.each(Object.entries(table))("%s passes exactly the rules it lists", async (_name, row) => {
    const world = await heardWorld();
    const threadId = await world.threadId();
    for (const rule of order) {
      // Each rule alone, on a fresh set of rows.
      await db().delete(representativeOutboundDecision);
      await db()
        .update(representativeThread)
        .set({ state: "representative" })
        .where(eq(representativeThread.id, threadId));
      await db().update(representativeCustomer).set({ blockedAt: null });
      await db().update(representativeCustomerIdentity).set({ optedOutAt: null });
      await db().update(representative).set({ enabled: true, maxInARow: 5 });
      await failsWith[rule]?.(threadId);
      const situation = situationOf([rule]);

      const decision = await db().transaction((tx) =>
        passGate(tx, {
          kind: row.kind,
          threadId,
          to: here,
          now: situation.now,
          businessStarted: situation.businessStarted,
          channel: { reach: () => reachOf([rule]) ?? {} },
          content: {
            text: "Hello there",
            verified: true,
            replyKind: "small_talk",
            sources: "sources" in situation ? situation.sources : [autoSource],
            topic: "topic" in situation ? situation.topic : "general",
          },
        }),
      );

      if (row.passes.includes(rule)) {
        expect(decision, `${row.kind} fails ${rule}`).toMatchObject({ rule });
        expect(decision!.outcome, `${row.kind} on ${rule}`).toBe(outcomeOf(row.kind, rule));
      } else {
        expect(decision, `${row.kind} ignores ${rule}`).toMatchObject({
          outcome: "send",
          rule: "passed",
        });
      }
    }
  });
});

describe("a reply while the owner holds the thread", () => {
  it("is refused, and the takeover note still goes", async () => {
    const world = await heardWorld();

    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    const result = await reply(world);

    expect(result).toMatchObject({ error: expect.stringContaining("nothing was sent") });
    await expect.poll(world.got, poll).toEqual([takeoverNote]);
    expect(await world.decisions()).toMatchObject([
      { kind: "takeover_note", outcome: "send", rule: "passed" },
      { kind: "reply", outcome: "drop", rule: "held", messageId: null },
    ]);
  });

  // The rules table doesn't list `held` for a proof, yet none goes: `requestProof` refuses before the
  // gate. It leaves no decision, which is what this test pins (see the ticket's report).
  it("also keeps a proof from going, before the gate, and leaves no decision for it", async () => {
    const world = await heardWorld();
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    await expect.poll(world.got, poll).toEqual([takeoverNote]);

    const sent = await db().transaction(async (tx) =>
      requestProof(tx, {
        keyring: ["a test secret"],
        channel: world.channel,
        userId: world.user.id,
        thread: {
          threadId: await world.threadId(),
          heard: here,
          verified: false,
          proofRule: "codeRoundTrip",
        },
        claimed: null,
        now: day,
      }),
    );

    expect(sent).toBeNull();
    expect((await world.decisions()).map(({ kind }) => kind)).toEqual(["takeover_note"]);
  });
});

describe("a reply on an auto topic", () => {
  const other = async (world: World) => {
    const [row] = await db()
      .select({ userId: representative.userId })
      .from(representative)
      .where(eq(representative.id, world.id));
    await db().insert(representativeFact).values({
      id: uuidv7(),
      userId: row!.userId,
      key: "pricing.note",
      type: "text",
      value: "Ten euros",
      topic: "pricing",
      createdAt: day,
      updatedAt: day,
    });
    await db().insert(representativeTopic).values({
      id: uuidv7(),
      userId: row!.userId,
      name: "pricing",
      mode: "draft",
    });
  };
  // The reply's own decision: a held Reply draft is followed by the holding note's.
  const ruleOfLast = async (world: World) =>
    (await world.decisions()).findLast(({ kind }) => kind === "reply")!.rule;

  /** The words wait as a Reply draft for the owner, and the Customer is given the holding note alone. */
  const expectDraft = async (world: World) => {
    await expect.poll(() => world.got().length, poll).toBe(1);
    expect(world.got()).not.toContain("Still here");
    expect(await db().select().from(representativeHeldMessage)).toMatchObject([
      { text: "Still here" },
    ]);
  };

  it("goes when it rests on Published facts of its topic", async () => {
    const world = await heardWorld();
    await expect(reply(world)).resolves.toEqual({ sent: true });
    await expect.poll(world.got, poll).toEqual(["Still here"]);
  });

  it("is held when it rests on nothing", async () => {
    const world = await heardWorld();
    await reply(world, { sources: [] });
    expect(await ruleOfLast(world)).toBe("topic");
    await expectDraft(world);
  });

  it("is held when it rests on a fact of another topic", async () => {
    const world = await heardWorld();
    await other(world);
    await reply(world, { sources: [{ type: "fact", key: "pricing.note" }] });
    expect(await ruleOfLast(world)).toBe("topic");
    await expectDraft(world);
  });

  it("is held when one of its sources is not a fact", async () => {
    const world = await heardWorld();
    await reply(world, { sources: [autoSource, { type: "memory", quote: "likes tea" }] });
    expect(await ruleOfLast(world)).toBe("topic");
    await expectDraft(world);
  });

  it("is held when its topic is still a draft, however well sourced", async () => {
    const world = await heardWorld();
    await other(world);
    await reply(world, { topic: "pricing", sources: [{ type: "fact", key: "pricing.note" }] });
    expect(await ruleOfLast(world)).toBe("topic");
    await expectDraft(world);
  });

  it("is held with a label the owner doesn't have", async () => {
    const world = await heardWorld();
    await reply(world, { topic: "weather" });
    expect(await ruleOfLast(world)).toBe("topic");
    await expectDraft(world);
  });
});

describe("no path sends without a decision", () => {
  it("leaves one send decision for everything the Customer is given, across the send sites", async () => {
    const world = await instance([
      guesses("Open at nine."), // code's hand-off message
      drafts("A draft."), // a Reply draft, and the holding note for the Customer
      quiet(),
      quiet(),
    ]);

    await world.hears("Hello");
    await world.hears("STOP"); // the opt-out confirmation
    await db().update(representativeCustomerIdentity).set({ optedOutAt: null });
    await world.hears("Hello again");
    await reply(world); // a Representative's reply
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    await world.rpc.representative.threadSend({ id: await world.threadId(), text: "It's me." });

    const decisions = await world.decisions();
    const sent = decisions.filter(({ outcome }) => outcome === "send");
    await expect.poll(() => world.got().length, poll).toBe(sent.length);
    const kinds = sent.map(({ kind }) => kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["reply", "takeover_note", "owner", "holding_note"]),
    );
    // Every message the Customer was given is a stored message a send decision points at.
    const stored = await db()
      .select({ id: representativeThreadMessage.id, text: representativeThreadMessage.text })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, await world.threadId()));
    const texts = sent.map(({ messageId }) => stored.find(({ id }) => id === messageId)?.text);
    expect(texts.every((text) => text !== undefined)).toBe(true);
    expect(world.got().toSorted()).toEqual(texts.toSorted());
    expect(world.got()).toContain(takeoverNote);
  });

  it("covers the code hand-off, the holding note and the opt-out confirmation too", async () => {
    const world = await instance([
      guesses("Open at nine."),
      guesses("Open at ten."),
      drafts("A draft."),
      quiet(),
    ]);
    await world.hears("Hello");
    await world.hears("Hello?");
    await world.hears("STOP");

    const decisions = await world.decisions();
    await expect
      .poll(() => world.got().length, poll)
      .toBe(decisions.filter(({ outcome }) => outcome === "send").length);
    expect(decisions.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["code_hand_off", "opt_out_confirmation"]),
    );
    expect(world.got()).toContain(handOffMessage);
  });

  it("leaves one for a proof, and none carries its secret", async () => {
    const world = await instance([
      round(toolCall({ name: "verify_customer", input: {}, id: "v" })),
      quiet(),
    ]);
    await testCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "Prove me",
      proof: { rule: "codeRoundTrip" },
    });

    await expect.poll(() => world.messaging.sends.length, poll).toBe(1);
    const decisions = await world.decisions();
    expect(decisions.filter(({ kind }) => kind === "proof")).toMatchObject([{ outcome: "send" }]);
    expect(JSON.stringify(decisions)).not.toContain(world.messaging.sends[0]!.message.text);
  });

  it("holds a message that a rule stops, stored and not sent, with its decision", async () => {
    const world = await heardWorld();
    await breakRows(world, ["caps"]);

    await reply(world);

    const [held] = await db().select().from(representativeHeldMessage);
    expect(await world.decisions()).toMatchObject([
      { outcome: "hold", rule: "caps", id: held!.decisionId },
    ]);
    expect(held).toMatchObject({ text: "Still here" });
    expect(world.got()).toEqual([]);
  });
});

describe("the emergency script", () => {
  /** The Representative has every rule but a block failing against an ordinary reply. */
  async function everythingExceptBlockFailing() {
    const world = await instance([quiet()], { at: night });
    await world.hears("Hello");
    await world.hears("STOP");
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    await db().update(representative).set({ maxInARow: 0 });
    return world;
  }

  it("goes past an owner's hold, an opt-out, a switch-off and a spent cap at once", async () => {
    const world = await everythingExceptBlockFailing();
    const before = world.got().length;

    await world.hears("fire");

    await expect.poll(() => world.got().length, poll).toBeGreaterThan(before);
    expect(world.got()).toContain(script);
    expect((await world.decisions()).at(-1)).toMatchObject({
      kind: "emergency_script",
      outcome: "send",
      rule: "passed",
    });
    // The same message as a reply would have been refused, by the earliest rule.
    expect(await reply(world, { now: night })).not.toEqual({ sent: true });
  });

  it("goes in a business-started message at night, on a topic the owner hasn't promoted, with all of those failing", async () => {
    const world = await everythingExceptBlockFailing();

    const decision = await db().transaction(async (tx) =>
      passGate(tx, {
        kind: "emergency_script",
        threadId: await world.threadId(),
        to: here,
        now: night,
        businessStarted: true,
        channel: { reach: () => ({}) },
        content: { text: script, verified: false, topic: "pricing", sources: [] },
      }),
    );

    expect(decision).toMatchObject({ outcome: "send", rule: "passed" });
  });

  it("is stopped by a block", async () => {
    const world = await everythingExceptBlockFailing();
    await breakRows(world, ["blocked"]);
    const before = world.got().length;

    await world.hears("fire");

    expect((await world.decisions()).at(-1)).toMatchObject({
      kind: "emergency_script",
      outcome: "drop",
      rule: "blocked",
    });
    expect(world.got()).toHaveLength(before);
  });

  // The table lists the Channel's limits for the script too: one it can't carry waits for the owner.
  it("is held, and not sent, by a Channel that can't carry it", async () => {
    const world = await heardWorld({ reach: { maxLength: 3 } });

    await world.arrives("fire");

    expect((await world.decisions()).at(-1)).toMatchObject({
      kind: "emergency_script",
      outcome: "hold",
      rule: "channel",
    });
    expect(world.got()).toEqual([]);
  });
});

describe("Pages with the Quota spent", () => {
  it("still reach the owner: the Quota's own, a held message's and an emergency's", async () => {
    const world = await instance([], { spent: true });
    const pages = async () => world.rpc.pages.list();

    await world.hears("Hello");
    expect((await pages()).map(({ cause }) => cause)).toEqual(["quota_spent"]);

    await breakRows(world, ["caps"]);
    await reply(world);
    expect((await pages()).map(({ cause }) => cause).toSorted()).toEqual([
      "outbound_held",
      "quota_spent",
    ]);

    await world.hears("fire");
    expect((await pages()).filter(({ urgency }) => urgency === "emergency")).toHaveLength(1);
    await expect.poll(world.got, poll).toContain(script);
    expect(world.entered).toEqual([]);
    expect(await db().select().from(page)).toHaveLength(3);
  });
});
