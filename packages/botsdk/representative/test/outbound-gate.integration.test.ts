import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { MessagingReach } from "@botsdk/bot/channel";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn, autoSource } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import {
  noCustomerChannel,
  type CustomerChannel,
  requestProof,
} from "../src/server/customer-proof";
import { storeReply } from "../src/server/customers";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeProfileValue,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { page } from "@botsdk/bot/storage";
import {
  enqueueHeldRelease,
  type GateRefusal,
  liveChecks,
  logRefusals,
  passGate,
} from "../src/server/outbound-gate";
import { representativeFeature } from "../src/server/plugin";
import { handOffMessage } from "../src/server/replies";
import { holdThread, takeoverNote } from "../src/server/takeover";

/*
 * The Outbound gate (ticket #1298), through the Representative's real reply path: a fake Model on
 * real Postgres, and a Customer channel over `fakeMessagingAdapter`. What a Customer got is what the
 * fake recorded, and why is the decision log.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
/** A daytime in UTC, the business's time zone by default: a message the business starts is held in quiet hours, so such tests pin one rather than read the real hour. */
const noon = new Date("2026-11-04T12:00:00Z");
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );
/** A reply no source backs: code refuses it. */
const guesses = (text: string) =>
  round(toolCall({ name: "reply", input: { topic: "general", text, kind: "answer" } }));

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
async function instance(
  rounds: Round[],
  held?: Promise<void>,
  at = new Date(),
  reach?: MessagingReach,
) {
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
    reach: () => reach,
  };
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
    channel,
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
    decisions: async (thread?: string) =>
      getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, thread ?? (await threadId())))
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
type Heard = { channel: string; externalId: string };

/** A Customer heard, on a thread with nothing sent on it yet. */
const heard = (world: World) => world.hears("Hello");

/** The Representative's reply, as the tool stores it, from a Turn still running. */
const anotherReply = async (
  world: World,
  now = new Date(),
  businessStarted = false,
  topic = "general",
) => {
  const feature = world.deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  const id = await world.threadId();
  return getTestDb().transaction((tx) =>
    storeReply(
      { ...feature.context, channel: world.channel },
      tx,
      {
        threadId: id,
        upTo: 1,
        heard: { channel: "fake", externalId: number },
        verified: false,
        businessStarted,
      },
      { text: "Still here", sources: topic === "general" ? [autoSource] : [], topic },
      "small_talk",
      now,
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

  it("stops going when the Channel keeps failing, and the log says so", async () => {
    const world = await instance([replies("We open at nine."), quiet()]);
    world.messaging.counts.sendFailures = 10;

    await world.hears("When do you open?");

    await expect
      .poll(async () => {
        world.timer.advance(60_000);
        world.timer.tick();
        return (await world.decisions()).map(({ outcome, rule }) => [outcome, rule]);
      }, poll)
      .toEqual([
        ["send", "passed"],
        ["drop", "delivery_failed"],
      ]);
    expect(world.got()).toEqual([]);
  });

  it("doesn't go on its retry to a Customer blocked since", async () => {
    const world = await instance([replies("We open at nine."), quiet()]);
    world.messaging.counts.sendFailures = 1;
    await world.hears("When do you open?");
    await expect.poll(() => world.messaging.counts.sendFailures, poll).toBe(0);

    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    await expect
      .poll(async () => {
        world.timer.advance(60_000);
        world.timer.tick();
        return (await world.decisions()).map(({ rule }) => rule);
      }, poll)
      .toEqual(["passed", "blocked"]);
    expect(world.got()).toEqual([]);
  });

  it("doesn't go on its retry to an address the owner has corrected", async () => {
    const world = await instance([replies("We open at nine."), quiet()]);
    world.messaging.counts.sendFailures = 1;
    await world.hears("When do you open?");
    await expect.poll(() => world.messaging.counts.sendFailures, poll).toBe(0);

    const [line] = await world.rpc.representative.threadList({ id: world.id });
    const customer = await world.rpc.representative
      .customerList()
      .then((all) => all.find(({ id }) => id === line!.customer.id)!);
    await world.rpc.representative.customerUpdateIdentity({
      id: customer.id,
      identityId: customer.identities[0]!.id,
      channel: "fake",
      externalId: "+15550999",
    });

    await expect
      .poll(async () => {
        world.timer.advance(60_000);
        world.timer.tick();
        return (await world.decisions()).map(({ rule }) => rule);
      }, poll)
      .toEqual(["passed", "address_changed"]);
    expect(world.got()).toEqual([]);
  });

  it("logs why when a takeover lands during its own write, which the Turn's fence rolls back", async () => {
    const held = opening();
    const world = await instance([replies("Too late."), quiet()], held.opened);
    const turn = world.hears("Hello");
    await expect.poll(() => world.entered.length, poll).toBe(1);
    const id = await world.threadId();

    await getTestDb().transaction(async (tx) => {
      const [thread] = await tx
        .select()
        .from(representativeThread)
        .where(eq(representativeThread.id, id))
        .for("update");
      held.open();
      // The reply's write has reached the thread's row, and waits for this takeover.
      await expect
        .poll(async () => {
          const waiting = await getTestDb().execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return waiting.rows.length;
        }, poll)
        .toBeGreaterThan(0);
      const feature = world.deps.parts.features.find(
        (each) => each.feature.id === "representative",
      )!;
      await holdThread({ ...feature.context, channel: noCustomerChannel }, tx, id, thread!);
    });
    await turn.catch(() => {});

    await expect
      .poll(async () => (await world.decisions()).map(({ kind, rule }) => [kind, rule]), poll)
      .toEqual([
        ["takeover_note", "passed"],
        ["reply", "held"],
      ]);
    await expect.poll(world.got, poll).toEqual([takeoverNote]);
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

describe("a proof for a blocked Customer", () => {
  const proofFor = (world: World, threadId: string, claimed: Heard | null = null) =>
    getTestDb().transaction((tx) =>
      requestProof(tx, {
        keyring: ["a test secret"],
        channel: noCustomerChannel,
        userId: world.user.id,
        thread: {
          threadId,
          heard: { channel: "fake", externalId: number },
          verified: false,
          proofRule: claimed ? "codeToRecord" : "codeRoundTrip",
        },
        claimed,
        now: world.timer.clock.now(),
      }),
    );

  it("doesn't go, and the decision says why", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello", { rule: "codeRoundTrip" });
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    const outgoing = await proofFor(world, line!.id);

    expect(outgoing).toBeNull();
    expect(await world.decisions()).toMatchObject([
      { kind: "proof", outcome: "drop", rule: "blocked" },
    ]);
  });

  it("isn't made for a claim on a blocked Customer's address, and the decision says why", async () => {
    const other = "+15550002";
    const world = await instance([quiet(), quiet()]);
    await world.hears("Hello");
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await testCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: other,
      message: "Hi",
    });
    const lines = await world.rpc.representative.threadList({ id: world.id });
    const blocked = lines.find(({ id }) => id !== line!.id)!;
    await world.rpc.representative.customerSetBlocked({ id: blocked.customer.id, blocked: true });

    const outgoing = await proofFor(world, line!.id, { channel: "fake", externalId: other });

    expect(outgoing).toBeNull();
    expect(await world.decisions(line!.id)).toMatchObject([
      { kind: "proof", outcome: "drop", rule: "blocked", externalId: other },
    ]);
  });

  it("doesn't go while a block is under way, and leaves no deadlock to wait for", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello", { rule: "codeRoundTrip" });
    const [line] = await world.rpc.representative.threadList({ id: world.id });

    const outgoing = await getTestDb().transaction(async (tx) => {
      await tx
        .update(representativeCustomer)
        .set({ blockedAt: new Date() })
        .where(eq(representativeCustomer.id, line!.customer.id));
      return proofFor(world, line!.id);
    });

    expect(outgoing).toBeNull();
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
          channel: world.channel,
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

describe("the outbound caps", () => {
  const pages = () => getTestDb().select().from(page);
  const held = () => getTestDb().select().from(representativeHeldMessage);
  const times = async (count: number, send: () => Promise<unknown>) => {
    for (let each = 0; each < count; each += 1) await send();
  };

  it("holds the sixth message in a row and Pages the owner", async () => {
    const world = await instance([quiet()]);
    await heard(world);

    await times(5, () => anotherReply(world));
    const sixth = await anotherReply(world);

    expect(sixth).toMatchObject({ error: expect.stringContaining("held") });
    await expect.poll(() => world.got().length, poll).toBe(5);
    expect((await world.decisions()).map(({ outcome, rule }) => [outcome, rule])).toEqual([
      ...Array.from({ length: 5 }, () => ["send", "passed"]),
      ["hold", "caps"],
    ]);
    expect(await held()).toMatchObject([{ text: "Still here" }]);
    expect(await pages()).toMatchObject([
      {
        userId: world.user.id,
        cause: "outbound_held",
        urgency: "routine",
        path: `/representatives/${world.id}`,
      },
    ]);
  });

  it("Pages once for the messages held on a thread while the owner has not dealt with them", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });

    await times(4, () => anotherReply(world));

    expect(await held()).toHaveLength(3);
    expect(await pages()).toHaveLength(1);
  });

  it("counts a held message the owner sent against the day", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1, maxPerDay: 3 });
    await times(2, () => anotherReply(world));
    const [message] = (await world.rpc.representative.threadGet({ id: await world.threadId() }))
      .held;
    await world.rpc.representative.threadHeldSend({ id: message!.id });
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 100 });

    expect(await anotherReply(world)).toEqual({ sent: true });
    expect(await anotherReply(world)).toMatchObject({ error: expect.stringContaining("held") });
  });

  it("starts the run again when the Customer replies", async () => {
    const world = await instance([quiet(), quiet()]);
    await heard(world);
    await times(5, () => anotherReply(world));

    await world.hears("Are you there?");
    await times(5, () => anotherReply(world));

    expect(await held()).toEqual([]);
    expect(await pages()).toEqual([]);
    await anotherReply(world);
    expect(await held()).toHaveLength(1);
  });

  it("holds the twenty-first message in a day and Pages the owner, until the day has passed", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 100 });

    await times(20, () => anotherReply(world));
    await anotherReply(world);

    expect((await world.decisions()).at(-1)).toMatchObject({ outcome: "hold", rule: "caps" });
    expect(await pages()).toHaveLength(1);
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await anotherReply(world, later)).toEqual({ sent: true });
  });

  it("applies the caps the owner edits, and shows them", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    expect((await world.rpc.representative.get({ id: world.id })).caps).toEqual({
      maxInARow: 5,
      maxPerDay: 20,
    });

    const edited = await world.rpc.representative.setCaps({ id: world.id, maxInARow: 2 });
    await times(3, () => anotherReply(world));

    expect(edited.caps).toEqual({ maxInARow: 2, maxPerDay: 20 });
    expect(await held()).toHaveLength(1);
    await expect(
      world.rpc.representative.setCaps({ id: world.id, maxPerDay: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const stranger = chatRpc({ user: await insertUser(), deps: world.deps });
    await expect(
      stranger.representative.setCaps({ id: world.id, maxPerDay: 3 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sends a held message when the owner says so, and logs it", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await times(2, () => anotherReply(world));
    const id = await world.threadId();
    const [message] = (await world.rpc.representative.threadGet({ id })).held;

    const view = await world.rpc.representative.threadHeldSend({ id: message!.id });

    await expect.poll(() => world.got(), poll).toEqual(["Still here", "Still here"]);
    expect(view.held).toEqual([]);
    expect(view.messages.filter(({ author }) => author === "representative")).toHaveLength(2);
    expect(await held()).toEqual([]);
    expect(
      (await world.decisions()).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    ).toEqual([
      ["reply", "send", "passed"],
      ["reply", "hold", "caps"],
      ["released", "send", "passed"],
    ]);
  });

  it("drops a held message when the owner says so, and logs it", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await times(2, () => anotherReply(world));
    const id = await world.threadId();
    const [message] = (await world.rpc.representative.threadGet({ id })).held;

    const view = await world.rpc.representative.threadHeldDrop({ id: message!.id });

    expect(view.held).toEqual([]);
    expect(await held()).toEqual([]);
    expect(
      (await world.decisions()).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    ).toEqual([
      ["reply", "send", "passed"],
      ["reply", "hold", "caps"],
      ["owner", "drop", "owner_dropped"],
    ]);
    await expect(
      world.rpc.representative.threadHeldDrop({ id: message!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect.poll(() => world.got(), poll).toEqual(["Still here"]);
  });

  it("keeps a held message the owner cannot send to a Customer blocked since, and logs why", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await times(2, () => anotherReply(world));
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    const [message] = (await world.rpc.representative.threadGet({ id: line!.id })).held;
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    await expect(world.rpc.representative.threadHeldSend({ id: message!.id })).rejects.toThrow(
      "blocked",
    );

    expect((await world.decisions()).at(-1)).toMatchObject({ outcome: "drop", rule: "blocked" });
    expect(await held()).toHaveLength(1);
  });

  it("replaces a held message with a new Customer message, and logs that", async () => {
    const world = await instance([quiet(), quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await times(2, () => anotherReply(world));
    expect(await held()).toHaveLength(1);

    await world.hears("Hello again");

    expect(await held()).toEqual([]);
    expect((await world.decisions()).map(({ outcome, rule }) => [outcome, rule])).toEqual([
      ["send", "passed"],
      ["hold", "caps"],
      ["drop", "replaced"],
    ]);
  });
});

describe("quiet hours", () => {
  /** 23:00 in UTC, the business's time zone until the owner sets another. */
  const night = new Date("2026-11-04T23:00:00Z");
  const held = () => getTestDb().select().from(representativeHeldMessage);
  const outcomes = async (world: World) =>
    (await world.decisions()).map(({ kind, outcome, rule }) => [kind, outcome, rule]);
  /** Moves the fake clock on and lets the runner see it. */
  const pass = (world: World, ms: number) => {
    world.timer.advance(ms);
    world.timer.tick();
  };
  const hour = 60 * 60 * 1000;
  const setCustomerZone = async (world: World, value: string) => {
    const [customer] = await world.rpc.representative.customerList();
    await world.rpc.representative.customerProfileSet({
      id: customer!.id,
      field: "time_zone",
      value,
    });
  };

  it("holds what the business starts at night, and sends it when the quiet hours end", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);

    const held = await anotherReply(world, night, true);

    expect(held).toMatchObject({ error: expect.stringContaining("held") });
    expect(world.got()).toEqual([]);
    expect(await outcomes(world)).toEqual([["reply", "hold", "quietHours"]]);
    // Quiet hours end by themselves: the owner isn't paged for them.
    expect(await getTestDb().select().from(page)).toEqual([]);

    pass(world, 9 * hour);
    await expect.poll(world.got, poll).toEqual(["Still here"]);
    // The held message sent later has a decision of its own.
    expect(await outcomes(world)).toEqual([
      ["reply", "hold", "quietHours"],
      ["released", "send", "passed"],
    ]);
  });

  it("holds the message until the quiet hours end, not a moment before", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);

    // 07:00: an hour of quiet is left.
    pass(world, 8 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.got()).toEqual([]);
    pass(world, hour);
    await expect.poll(world.got, poll).toEqual(["Still here"]);
  });

  it("sends a direct reply to a Customer who just wrote at any hour", async () => {
    const world = await instance([replies("We open at nine."), quiet()], undefined, night);

    await world.hears("When do you open?");

    await expect.poll(world.got, poll).toEqual(["We open at nine."]);
    expect(await outcomes(world)).toEqual([["reply", "send", "passed"]]);
  });

  it("drops a held message that a new Customer message replaced, and the log says so", async () => {
    const world = await instance([quiet(), quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);

    await world.hears("Are you there?");
    pass(world, 9 * hour);

    expect(await held()).toEqual([]);
    expect(await outcomes(world)).toEqual([
      ["reply", "hold", "quietHours"],
      ["reply", "drop", "replaced"],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.got()).toEqual([]);
  });

  it("uses the Customer's time zone when it is known", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    // 12:00 in Auckland: the business's UTC night isn't the Customer's.
    await setCustomerZone(world, "Pacific/Auckland");

    expect(await anotherReply(world, night, true)).toEqual({ sent: true });
    expect(await outcomes(world)).toEqual([["reply", "send", "passed"]]);
  });

  it("holds by the Customer's night even when it is the business's day", async () => {
    const world = await instance([quiet()], undefined, new Date("2026-11-04T12:00:00Z"));
    await heard(world);
    // 21:00 in Tokyo, while 12:00 in UTC is the business's day.
    await setCustomerZone(world, "Asia/Tokyo");

    expect(await anotherReply(world, world.timer.clock.now(), true)).toMatchObject({
      error: expect.stringContaining("held"),
    });
  });

  it("falls back to the business's time zone when the Customer's is unknown", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await world.rpc.representative.setQuietHours({
      id: world.id,
      startHour: 21,
      endHour: 8,
      timeZone: "Pacific/Auckland",
    });

    expect(await anotherReply(world, night, true)).toEqual({ sent: true });
  });

  it("lets the owner edit the hours and the business time zone, and shows them", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    expect((await world.rpc.representative.get({ id: world.id })).quietHours).toEqual({
      startHour: 21,
      endHour: 8,
      timeZone: "UTC",
    });

    const edited = await world.rpc.representative.setQuietHours({
      id: world.id,
      startHour: 0,
      endHour: 6,
      timeZone: "Europe/Paris",
    });

    expect(edited.quietHours).toEqual({ startHour: 0, endHour: 6, timeZone: "Europe/Paris" });
    // 00:00 in Paris is 23:00 UTC the day before: the edited hours apply.
    expect(await anotherReply(world, night, true)).toMatchObject({
      error: expect.stringContaining("held"),
    });
    await expect(
      world.rpc.representative.setQuietHours({
        id: world.id,
        startHour: 0,
        endHour: 6,
        timeZone: "Not/AZone",
      }),
    ).rejects.toThrow();
  });

  it("doesn't bring back a held message the Customer's new message dropped during the Turn", async () => {
    const world = await instance([quiet(), quiet()], undefined, night);
    await heard(world);
    const feature = world.deps.parts.features.find(
      ({ feature }) => feature.id === "representative",
    )!;
    const refusals: GateRefusal[] = [];
    const threadId = await world.threadId();
    await getTestDb().transaction((tx) =>
      storeReply(
        { ...feature.context, channel: noCustomerChannel },
        tx,
        {
          threadId,
          upTo: 1,
          heard: { channel: "fake", externalId: number },
          verified: false,
          businessStarted: true,
          refusals,
        },
        { text: "Stale news", sources: [], topic: "general" },
        "small_talk",
        night,
      ),
    );
    await world.hears("Are you there?");
    expect(await held()).toEqual([]);

    // The Turn ends and writes its refusals again.
    await logRefusals(feature.context, refusals);
    pass(world, 9 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await held()).toEqual([]);
    expect(world.got()).toEqual([]);
  });

  it("drops a held message once its Representative is switched off", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });

    pass(world, 9 * hour);

    await expect
      .poll(() => outcomes(world), poll)
      .toEqual([
        ["reply", "hold", "quietHours"],
        ["released", "drop", "on"],
      ]);
    expect(await held()).toEqual([]);
    expect(world.got()).toEqual([]);
  });

  it("keeps a held message from an opted-out Customer when quiet hours end", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);
    // An opt-out that landed after the hold, as a race would leave it.
    await getTestDb()
      .update(representativeCustomerIdentity)
      .set({ optedOutAt: night, optOutSource: "keyword" });

    pass(world, 9 * hour);

    await expect
      .poll(() => outcomes(world), poll)
      .toEqual([
        ["reply", "hold", "quietHours"],
        ["released", "drop", "optedOut"],
      ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.got()).toEqual([]);
  });

  it("leaves nothing to release when the Customer says STOP during quiet hours", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);

    await world.hears("STOP");
    pass(world, 9 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await held()).toEqual([]);
    expect(world.got()).not.toContain("Still here");
  });

  it("holds what the caps stop when quiet hours end, and Pages once", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await anotherReply(world, night, true);
    await anotherReply(world, night, true);

    pass(world, 9 * hour);

    await expect.poll(world.got, poll).toEqual(["Still here"]);
    await expect.poll(async () => (await outcomes(world)).length, poll).toBe(4);
    expect(await held()).toHaveLength(1);
    expect((await outcomes(world)).slice(2).sort()).toEqual([
      ["released", "hold", "caps"],
      ["released", "send", "passed"],
    ]);
    const [written] = await getTestDb().select().from(page);
    expect(written).toMatchObject({ cause: "outbound_held" });
    // What holds it now, not the quiet hours it went past, and in the owner's words.
    expect(written!.text).toContain("your limits on how much it may send");
    expect(written!.text).not.toContain("caps");
    expect((await world.rpc.representative.inbox()).held).toMatchObject([{ rule: "caps" }]);
  });

  it("doesn't let a repeat of its release send what a cap held again", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await anotherReply(world, night, true);
    await anotherReply(world, night, true);
    pass(world, 9 * hour);
    await expect.poll(async () => (await outcomes(world)).length, poll).toBe(4);
    const [left] = await held();
    await getTestDb().transaction((tx) =>
      enqueueHeldRelease(
        world.deps.parts.features.find(({ feature }) => feature.id === "representative")!.context
          .jobs,
        tx,
        left!.id,
        new Date(night.getTime() + 10 * hour),
      ),
    );

    pass(world, 2 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(world.got()).toEqual(["Still here"]);
    expect(await held()).toHaveLength(1);
  });

  it("leaves a held message for the owner when its topic is still a draft", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true, "A new subject");

    pass(world, 9 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(world.got()).toEqual([]);
    expect(await held()).toHaveLength(1);
    // Still a plain held message, which isn't a Reply draft though its topic held it.
    expect(await outcomes(world)).toContainEqual(["released", "hold", "topicAtRelease"]);
    expect(await getTestDb().select().from(page)).toMatchObject([{ cause: "outbound_held" }]);
    expect((await world.rpc.representative.inbox()).held).toMatchObject([
      { rule: "topicAtRelease" },
    ]);
    expect(await world.rpc.representative.replyDraftList()).toEqual([]);
  });

  it("waits again when the owner has since extended the quiet hours", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);
    await world.rpc.representative.setQuietHours({
      id: world.id,
      startHour: 21,
      endHour: 10,
      timeZone: "UTC",
    });

    // 08:00: the old end.
    pass(world, 9 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.got()).toEqual([]);
    expect(await held()).toHaveLength(1);

    pass(world, 2 * hour);
    await expect.poll(world.got, poll).toEqual(["Still here"]);
  });

  it("ignores a time zone an unverified sender claimed", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    const [customer] = await world.rpc.representative.customerList();
    await getTestDb().insert(representativeProfileValue).values({
      id: crypto.randomUUID(),
      userId: world.user.id,
      customerId: customer!.id,
      fixedField: "time_zone",
      value: "Pacific/Auckland",
      source: "customer",
      status: "claimed",
      recordedAt: night,
    });

    expect(await anotherReply(world, night, true)).toMatchObject({
      error: expect.stringContaining("held"),
    });
  });

  it("leaves a message held for the owner who took the thread over", async () => {
    const world = await instance([quiet()], undefined, night);
    await heard(world);
    await anotherReply(world, night, true);
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });

    pass(world, 9 * hour);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(world.got()).toEqual([takeoverNote]);
    expect(await held()).toHaveLength(1);
  });
});

describe("a Channel's limits", () => {
  const hour = 60 * 60 * 1000;
  const pages = () => getTestDb().select().from(page);
  const held = () => getTestDb().select().from(representativeHeldMessage);
  const outcomes = async (world: World) =>
    (await world.decisions()).map(({ outcome, rule }) => [outcome, rule]);
  const heldAndPaged = async (world: World) => {
    expect(world.got()).toEqual([]);
    expect(await held()).toMatchObject([{ text: "Still here" }]);
    expect(await pages()).toMatchObject([{ userId: world.user.id, cause: "outbound_held" }]);
  };

  it("holds a reply outside the reply window and Pages the owner, by the clock", async () => {
    const world = await instance([quiet()], undefined, new Date(), { replyWindowHours: 24 });
    await heard(world);
    const inside = new Date(Date.now() + 23 * hour);
    const outside = new Date(Date.now() + 25 * hour);

    await anotherReply(world, inside);
    const late = await anotherReply(world, outside);

    expect(late).toMatchObject({ error: expect.stringContaining("held") });
    await expect.poll(() => world.got(), poll).toEqual(["Still here"]);
    expect(await outcomes(world)).toEqual([
      ["send", "passed"],
      ["hold", "channel"],
    ]);
    expect(await held()).toHaveLength(1);
    expect(await pages()).toMatchObject([{ cause: "outbound_held" }]);
  });

  it("holds what the business starts on a Channel that can't start a chat", async () => {
    const world = await instance([quiet()], undefined, noon, {
      canStartConversation: false,
    });
    await heard(world);

    const started = await anotherReply(world, noon, true);

    expect(started).toMatchObject({ error: expect.stringContaining("held") });
    expect(await outcomes(world)).toEqual([["hold", "channel"]]);
    await heldAndPaged(world);
  });

  it("still answers a Customer who just wrote on a Channel that can't start a chat", async () => {
    const world = await instance([quiet()], undefined, new Date(), {
      canStartConversation: false,
    });
    await heard(world);

    await anotherReply(world);

    await expect.poll(() => world.got(), poll).toEqual(["Still here"]);
  });

  it("holds a message over the Channel's longest", async () => {
    const world = await instance([quiet()], undefined, new Date(), { maxLength: 9 });
    await heard(world);

    const long = await anotherReply(world);

    expect(long).toMatchObject({ error: expect.stringContaining("held") });
    expect(await outcomes(world)).toEqual([["hold", "channel"]]);
    await heldAndPaged(world);
  });

  it("sends as before when the adapter declares nothing", async () => {
    const world = await instance([quiet()]);
    await heard(world);

    await anotherReply(world, noon, true);

    await expect.poll(() => world.got(), poll).toEqual(["Still here"]);
    expect(await outcomes(world)).toEqual([["send", "passed"]]);
    expect(await pages()).toEqual([]);
  });

  it("doesn't send a held message to another identity of an unverified Customer", async () => {
    const world = await instance([quiet()], undefined, new Date(), { replyWindowHours: 24 });
    await heard(world);
    const [customer] = await world.rpc.representative.customerList();
    await world.rpc.representative.customerAddIdentity({
      id: customer!.id,
      channel: "fake",
      externalId: "+15550002",
    });

    await anotherReply(world, new Date(Date.now() + 25 * hour));

    expect(world.got()).toEqual([]);
    const [decision] = await world.decisions();
    expect(decision).toMatchObject({ outcome: "hold", rule: "channel", externalId: number });
  });

  it("holds a message held for quiet hours again when its window has closed by morning", async () => {
    const night = new Date("2026-11-04T23:00:00Z");
    const world = await instance([quiet()], undefined, night, { replyWindowHours: 8 });
    await heard(world);
    // The Customer wrote just now by the real clock; the business starts a reply at 23:00 the same day.
    await getTestDb()
      .update(representativeThreadMessage)
      .set({ createdAt: new Date("2026-11-04T22:00:00Z") });
    await anotherReply(world, night, true);

    world.timer.advance(9 * hour);
    world.timer.tick();
    // By 07:00 it is 9 hours since the Customer wrote: out of the 8-hour window.
    await expect.poll(async () => (await outcomes(world)).length, poll).toBe(2);

    expect(await outcomes(world)).toEqual([
      ["hold", "quietHours"],
      ["hold", "channel"],
    ]);
    expect(world.got()).toEqual([]);
    expect(await held()).toHaveLength(1);
  });

  it("holds what the business started again by morning on a Channel that can't start a chat", async () => {
    const night = new Date("2026-11-04T23:00:00Z");
    const world = await instance([quiet()], undefined, night, { canStartConversation: false });
    await heard(world);
    await anotherReply(world, night, true);

    world.timer.advance(9 * hour);
    world.timer.tick();
    await expect.poll(async () => (await outcomes(world)).length, poll).toBe(2);

    expect(await outcomes(world)).toEqual([
      ["hold", "quietHours"],
      ["hold", "channel"],
    ]);
    expect(world.got()).toEqual([]);
  });

  /** A reply labelled with a topic the owner hasn't promoted: it waits as a Reply draft. */
  const draftReply = () =>
    round(
      toolCall({
        name: "reply",
        input: { topic: "billing", sources: [], text: "Hi", kind: "small_talk" },
      }),
    );

  it("keeps an approved draft waiting, and tells the owner why, outside the reply window", async () => {
    const world = await instance([draftReply(), quiet()], undefined, new Date(), {
      replyWindowHours: 24,
    });
    await world.hears("What do I owe?");
    await expect
      .poll(async () => (await world.rpc.representative.replyDraftList()).length, poll)
      .toBe(1);
    const [draft] = await world.rpc.representative.replyDraftList();
    world.timer.advance(25 * hour);

    await expect(
      world.rpc.representative.replyDraftApprove({ id: draft!.id }),
    ).rejects.toMatchObject({
      data: { code: "error.channelLimits" },
    });

    expect(await world.rpc.representative.replyDraftList()).toHaveLength(1);
    expect((await outcomes(world)).at(-1)).toEqual(["drop", "channel"]);
    expect(world.got()).not.toContain("Hi");
  });

  it("refuses the owner's own message outside the reply window, and keeps nothing held", async () => {
    const world = await instance([quiet()], undefined, new Date(), { replyWindowHours: 24 });
    await world.hears("Hello");
    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });
    world.timer.advance(25 * hour);

    await expect(
      world.rpc.representative.threadSend({ id, text: "It's me." }),
    ).rejects.toMatchObject({
      data: { code: "error.channelLimits" },
    });

    expect(await held()).toEqual([]);
    expect(world.got()).not.toContain("It's me.");
    expect((await outcomes(world)).at(-1)).toEqual(["drop", "channel"]);
    expect(await pages()).toEqual([]);
  });

  it("drops a holding note the Channel's limits stop, and the draft still waits", async () => {
    const world = await instance([draftReply(), quiet()], undefined, new Date(), { maxLength: 10 });

    await world.hears("What do I owe?");

    await expect.poll(async () => (await outcomes(world)).length, poll).toBe(2);
    expect(await outcomes(world)).toEqual([
      ["hold", "topic"],
      ["drop", "channel"],
    ]);
    expect(world.got()).toEqual([]);
    expect(await world.rpc.representative.replyDraftList()).toHaveLength(1);
  });

  it("lets the owner send a held message, or drop it", async () => {
    const world = await instance([quiet()], undefined, new Date(), { maxLength: 9 });
    await heard(world);
    await anotherReply(world);
    await anotherReply(world);
    const id = await world.threadId();
    const [first, second] = (await world.rpc.representative.threadGet({ id })).held;

    await world.rpc.representative.threadHeldSend({ id: first!.id });
    await world.rpc.representative.threadHeldDrop({ id: second!.id });

    await expect.poll(() => world.got(), poll).toEqual(["Still here"]);
    expect(await held()).toEqual([]);
  });
});

describe("the owner's inbox", () => {
  it("lists what the gate held and the threads running, across Representatives, with who each is", async () => {
    const world = await instance([quiet(), quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await anotherReply(world);
    await anotherReply(world);
    const second = await world.rpc.representative.create({ name: "Billing desk" });
    await world.rpc.representative.updateDraft({
      id: second.id,
      draft: { jobText: "Answer billing.", model, tools: ["reply"] },
    });
    await world.rpc.representative.approve({ id: second.id });
    await world.rpc.representative.setEnabled({ id: second.id, enabled: true });
    await testCustomerTurn(world.deps, {
      representativeId: second.id,
      externalId: "+15550002",
      message: "Hi",
    });
    const [message] = (await world.rpc.representative.threadGet({ id: await world.threadId() }))
      .held;

    const inbox = await world.rpc.representative.inbox();

    expect(inbox.held).toMatchObject([
      {
        id: message!.id,
        text: "Still here",
        rule: "caps",
        representativeId: world.id,
        representativeName: "Front desk",
        threadId: await world.threadId(),
      },
    ]);
    expect(inbox.running.map(({ representativeName }) => representativeName).sort()).toEqual([
      "Billing desk",
      "Front desk",
    ]);
    expect(inbox.running.every(({ holder }) => holder === "representative")).toBe(true);
  });

  it("leaves a thread the owner holds, or that is closed, out of the running ones, and a draft out of the held", async () => {
    const draft = round(
      toolCall({
        name: "reply",
        input: { topic: "billing", sources: [], text: "Hi", kind: "small_talk" },
      }),
    );
    const world = await instance([draft, quiet()]);
    await world.hears("What do I owe?");
    expect(await world.rpc.representative.replyDraftList()).toHaveLength(1);
    const id = await world.threadId();

    await world.rpc.representative.threadTakeOver({ id });
    expect((await world.rpc.representative.inbox()).running).toEqual([]);

    await world.rpc.representative.threadHandBack({ id });
    expect((await world.rpc.representative.inbox()).running).toMatchObject([{ id }]);
    expect((await world.rpc.representative.inbox()).held).toEqual([]);
  });

  it("is the owner's: another owner sees none of it", async () => {
    const world = await instance([quiet()]);
    await heard(world);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await anotherReply(world);
    await anotherReply(world);
    expect((await world.rpc.representative.inbox()).held).toHaveLength(1);
    const stranger = chatRpc({ user: await insertUser(), deps: world.deps });

    expect(await stranger.representative.inbox()).toEqual({
      held: [],
      running: [],
      truncated: { held: false, drafts: false, running: false },
    });
  });
});
