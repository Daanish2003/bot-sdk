import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { type MessagingReach } from "@botsdk/bot/channel";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/client/uuidv7";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  autoSource,
  fakeChannel,
  promoteAutoTopic,
  startTestCustomerTurn,
  testCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representative,
  representativeCustomer,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
} from "../src/server/db/schema";
import { threadIdleMs } from "../src/server/idle";
import { limitNote } from "../src/server/limits";
import { representativeFeature } from "../src/server/plugin";

/*
 * What the Outbound gate's rules meet at their edges (the #1171 branch review): a Turn stopped holding
 * a draft, an opt-out beside another address's question, a note the gate wouldn't send. Fake Models on
 * real Postgres, a Customer channel over `fakeMessagingAdapter`, and a clock pinned to 09:00 UTC so a
 * business-started path holds at any hour.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const first = "+15550001";
const second = "+15550002";
const at = new Date("2026-10-22T09:00:00.000Z");
const hour = 60 * 60_000;
const proof = { rule: "sameIdentity" } as const;
const settled = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { text, kind: "small_talk", topic: "general", sources: [autoSource] },
    }),
  );
/** A reply with no label, which the gate holds as a Reply draft. */
const drafts = (text: string) =>
  round(toolCall({ name: "reply", input: { text, kind: "small_talk" } }));
/** An answer with no source, which the Turn's check refuses. */
const refused = () =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [], text: "It is 20.", kind: "answer" },
    }),
  );

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

function opening() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  onTestFinished(() => open());
  return { opened, open };
}

/** A running instance, whose Turn stands at Model call `standAt` until `open` is called. */
async function instance(rounds: Round[], { standAt }: { standAt?: number } = {}) {
  const fake = createFakeAdapter({ rounds });
  const stand = opening();
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      if (entered.length === standAt) await stand.opened;
      yield* fake.adapter.chatStream(options);
    },
  };
  const botFake = createFakeAdapter({ rounds: Array.from({ length: 5 }, () => quiet()) });
  const messaging = fakeMessagingAdapter();
  const account = {
    id: "account",
    botId: "bot",
    platformBotId: "1",
    handle: "@bot_1",
    credentials: { token: "1:secret" },
  };
  let reach: MessagingReach = {};
  const channel: CustomerChannel = {
    reach: () => reach,
    send: async (to, { text }) => {
      await messaging.adapter.send(account, { chatId: to.externalId, text }, { fetch });
    },
    sendProof: async () => {},
  };
  const timer = fakeJobClock(at);
  const ban = { on: false };
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
    adapterFor: (id) => (id === botModel ? botFake.adapter : adapter),
    users: { isBlocked: async () => ban.on },
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
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  const row = async () => {
    const [thread] = await getTestDb()
      .select()
      .from(representativeThread)
      .where(eq(representativeThread.id, await threadId()));
    return thread!;
  };
  const held = async () =>
    (
      await getTestDb()
        .select()
        .from(representativeHeldMessage)
        .where(eq(representativeHeldMessage.threadId, await threadId()))
        .orderBy(asc(representativeHeldMessage.id))
    ).map(({ text, resolution }) => [text, resolution]);
  return {
    entered,
    open: stand.open,
    rpc,
    id,
    user,
    ban,
    deps: world,
    timer,
    threadId,
    row,
    held,
    limitChannel: (to: MessagingReach) => {
      reach = to;
    },
    hears: (message: string, externalId = first, sent?: typeof proof) =>
      testCustomerTurn(world, { representativeId: id, externalId, message, proof: sent }),
    starts: (message: string, externalId = first, sent?: typeof proof) =>
      startTestCustomerTurn(world, { representativeId: id, externalId, message, proof: sent }),
    /** Moves the clock on and has the runner look, so what came due runs. */
    pass: (ms = 60_000) => {
      timer.advance(ms);
      timer.tick();
    },
    /** A second address of the thread's Customer. */
    addSecond: async () => {
      const [line] = await rpc.representative.threadList({ id });
      await rpc.representative.customerAddIdentity({
        id: line!.customer.id,
        channel: fakeChannel,
        externalId: second,
      });
    },
    got: () => messaging.delivered.map(({ part }) => part),
    to: () => messaging.delivered.map(({ part, chatId }) => [chatId, part]),
    setGateCaps: (caps: { maxInARow?: number; maxPerDay?: number }) =>
      getTestDb().update(representative).set(caps).where(eq(representative.id, id)),
    decisions: async () =>
      (
        await getTestDb()
          .select()
          .from(representativeOutboundDecision)
          .where(eq(representativeOutboundDecision.threadId, await threadId()))
          .orderBy(asc(representativeOutboundDecision.id))
      ).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** The thread as a limit leaves it, with something for the owner to answer. */
const leaveForOwner = async (world: World) =>
  getTestDb()
    .update(representativeThread)
    .set({ leftForOwnerAt: world.timer.clock.now() })
    .where(eq(representativeThread.id, await world.threadId()));

describe("a Ban on a Turn that holds a draft", () => {
  it("takes the draft with it, as its batch waits again and would be answered twice", async () => {
    const world = await instance([drafts("You owe nothing."), quiet()], { standAt: 2 });
    await world.starts("What do I owe?");
    world.pass();
    await expect.poll(() => world.entered.length, poll).toBe(2);

    await world.deps.bots.stopTurns({ userId: world.user.id });
    world.open();

    expect((await world.row()).waitingFrom).toBe(1);
    expect(await world.held()).toEqual([["You owe nothing.", "replaced"]]);
  });
});

describe("a cap reached after a reply the gate held", () => {
  it("counts the held reply as the answer: no note, and a lift answers nothing twice", async () => {
    const world = await instance([replies("Held one"), replies("Held two"), quiet()]);
    await world.setGateCaps({ maxPerDay: 0 });
    await world.rpc.representative.setSpendingCaps({ id: world.id, threadCalls: 1 });

    await world.hears("Hello");
    await expect.poll(world.held, poll).toEqual([["Held one", null]]);
    await settled();
    expect(world.got()).not.toContain(limitNote);

    await world.rpc.representative.setSpendingCaps({ id: world.id, threadCalls: 100 });
    world.pass(hour);
    await settled();
    expect(world.entered).toHaveLength(1);
    expect(await world.held()).toEqual([["Held one", null]]);
  });
});

describe("an opt-out by one address", () => {
  it("leaves another address's question its Turn", async () => {
    const world = await instance([quiet(), replies("Here's your answer"), quiet()]);
    await world.hears("Hello");
    await world.addSecond();
    await world.starts("A question from the first");

    await world.hears("STOP", second);
    world.pass();

    await expect.poll(world.got, poll).toContain("Here's your answer");
    expect(world.to().find(([, part]) => part === "Here's your answer")![0]).toBe(first);
  });

  it("moves the waiting mark past only what that address said", async () => {
    const world = await instance([quiet(), quiet()]);
    await world.hears("Hello");
    await world.addSecond();
    await world.starts("A question from the second", second);
    await world.starts("And one from the first");
    const position = (await world.row()).messageCount;

    await world.hears("STOP", second);

    expect((await world.row()).waitingFrom).toBe(position);
  });

  it("leaves a running Turn for the other address owing its batch, for a takeover to give back", async () => {
    const world = await instance([quiet(), replies("Too late"), quiet()], { standAt: 2 });
    await world.hears("Hello");
    await world.addSecond();
    await world.starts("A question from the first");
    const position = (await world.row()).messageCount;
    world.pass();
    await expect.poll(() => world.entered.length, poll).toBe(2);

    await world.hears("STOP", second);
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });

    expect((await world.row()).waitingFrom).toBe(position);
    world.open();
  });

  it("drops only what was going to that address, even for a verified sender", async () => {
    const world = await instance([drafts("For the first"), quiet(), quiet()]);
    await world.hears("Hello", first, proof);
    await expect.poll(world.held, poll).toEqual([["For the first", null]]);
    await world.addSecond();

    await world.hears("STOP", second, proof);

    expect(await world.held()).toEqual([["For the first", null]]);
  });
});

describe("a limit note the gate wouldn't send", () => {
  it("still has the thread looked at again, so what waits is answered when the limit lifts", async () => {
    const world = await instance([quiet(), replies("Hi"), quiet()]);
    await world.rpc.representative.setSpendingCaps({ id: world.id, threadCalls: 1 });
    await world.hears("Hello");
    // The note is longer than this; the answer isn't.
    world.limitChannel({ maxLength: 10 });

    await world.hears("Anyone?");

    expect(world.got()).toEqual([]);
    expect(await world.decisions()).toContainEqual(["limit_note", "drop", "channel"]);
    expect((await world.row()).limitNotedAt).toBeNull();

    await world.rpc.representative.setSpendingCaps({ id: world.id, threadCalls: 100 });
    world.pass(hour);
    await expect.poll(async () => (await world.row()).turnId, poll).not.toBeNull();
    world.pass();

    await expect.poll(world.got, poll).toEqual(["Hi"]);
  });
});

describe("code's hand-off held by the Channel's limits", () => {
  it("still gives the Bot the work its message promises, and the message waits for the owner", async () => {
    const world = await instance([refused(), refused(), quiet(), quiet()]);
    world.limitChannel({ maxLength: 1 });

    await world.hears("How much is it?");

    await expect
      .poll(() => getTestDb().select({ id: botAssignment.id }).from(botAssignment), poll)
      .toHaveLength(1);
    expect((await world.held()).map(([, resolution]) => resolution)).toEqual([null]);
    expect(await world.decisions()).toContainEqual(["code_hand_off", "hold", "channel"]);
  });
});

describe("what is left for the owner", () => {
  /** A thread with a draft waiting and something left for the owner. */
  async function draftAndLeft() {
    const world = await instance([drafts("About the new one"), quiet()]);
    await world.hears("The new one");
    await expect.poll(world.held, poll).toEqual([["About the new one", null]]);
    await leaveForOwner(world);
    const [draft] = await world.rpc.representative.replyDraftList();
    return { world, draft: draft! };
  }

  /** A thread with what a cap holds waiting and something left for the owner. */
  async function heldAndLeft() {
    const world = await instance([replies("Held"), quiet()]);
    await world.setGateCaps({ maxPerDay: 0 });
    await world.hears("Hello");
    await expect.poll(world.held, poll).toEqual([["Held", null]]);
    await leaveForOwner(world);
    const [held] = (await world.rpc.representative.threadGet({ id: await world.threadId() })).held;
    return { world, held: held! };
  }

  it("is answered by an unedited approval", async () => {
    const { world, draft } = await draftAndLeft();
    await world.rpc.representative.replyDraftApprove({ id: draft.id });
    expect((await world.row()).leftForOwnerAt).toBeNull();
  });

  it("is settled by the owner rejecting the draft", async () => {
    const { world, draft } = await draftAndLeft();
    await world.rpc.representative.replyDraftReject({ id: draft.id });
    expect((await world.row()).leftForOwnerAt).toBeNull();
  });

  it("is answered by the owner sending what was held", async () => {
    const { world, held } = await heldAndLeft();
    await world.rpc.representative.threadHeldSend({ id: held.id });
    expect((await world.row()).leftForOwnerAt).toBeNull();
  });

  it("is settled by the owner dropping what was held", async () => {
    const { world, held } = await heldAndLeft();
    await world.rpc.representative.threadHeldDrop({ id: held.id });
    expect((await world.row()).leftForOwnerAt).toBeNull();
  });

  it("is answered by a later Turn's reply to a newer message", async () => {
    const world = await instance([quiet(), replies("Answered"), quiet()]);
    await world.hears("Hello");
    await leaveForOwner(world);
    world.timer.advance(hour);

    await world.hears("Anyone there?");

    await expect.poll(world.got, poll).toEqual(["Answered"]);
    await expect.poll(async () => (await world.row()).leftForOwnerAt, poll).toBeNull();
  });

  it("isn't answered by a reply to a message older than it", async () => {
    const world = await instance([replies("Answered"), quiet()], { standAt: 1 });
    await world.starts("Hello");
    world.pass();
    await expect.poll(() => world.entered.length, poll).toBe(1);
    // As `beginTurn` leaves it: what is older left for the owner, and this Turn answers what is fresh.
    world.timer.advance(1_000);
    await leaveForOwner(world);

    world.open();

    await expect.poll(world.got, poll).toEqual(["Answered"]);
    await expect.poll(async () => (await world.row()).turnId, poll).toBeNull();
    expect((await world.row()).leftForOwnerAt).not.toBeNull();
  });

  /** Has the idle check come due, with the thread's activity long past. */
  const pastIdle = async (world: World) => {
    world.pass(2 * threadIdleMs);
    await settled(500);
    world.pass(2 * threadIdleMs);
    await settled(500);
  };

  it("doesn't keep an opted-out Customer's thread open: nothing can be sent to answer it", async () => {
    const world = await instance([quiet(), quiet()]);
    await world.hears("Hello");
    await world.hears("STOP");
    await leaveForOwner(world);
    await pastIdle(world);
    await expect.poll(async () => (await world.row()).state, poll).toBe("closed");
  });

  it("doesn't keep a blocked Customer's thread open", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });
    await leaveForOwner(world);
    await pastIdle(world);
    await expect.poll(async () => (await world.row()).state, poll).toBe("closed");
  });

  it("still keeps the thread of a Customer who can be answered", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    await leaveForOwner(world);
    await pastIdle(world);
    expect((await world.row()).state).toBe("representative");
  });
});

describe("the owner's inbox", () => {
  /** Stored rows as many as `count`, so a list's limit can be met without that many Turns. */
  async function manyHeld(world: World, threadId: string, count: number, rule: string) {
    const now = world.timer.clock.now();
    const decisions = Array.from({ length: count }, () => ({
      id: uuidv7(),
      threadId,
      kind: "reply" as const,
      outcome: "hold" as const,
      rule,
      channel: fakeChannel,
      externalId: first,
      createdAt: now,
    }));
    await getTestDb().insert(representativeOutboundDecision).values(decisions);
    await getTestDb()
      .insert(representativeHeldMessage)
      .values(
        decisions.map(({ id }) => ({
          id: uuidv7(),
          decisionId: id,
          threadId,
          text: "Held",
          verified: false,
          replyKind: "small_talk" as const,
          createdAt: now,
        })),
      );
  }

  it("says when it can't list all that is held, or every draft", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const threadId = await world.threadId();

    await manyHeld(world, threadId, 200, "caps");
    await manyHeld(world, threadId, 200, "topic");
    expect((await world.rpc.representative.inbox()).truncated).toEqual({
      held: false,
      drafts: false,
      running: false,
    });

    await manyHeld(world, threadId, 1, "caps");
    await manyHeld(world, threadId, 1, "topic");
    const inbox = await world.rpc.representative.inbox();
    expect(inbox.held).toHaveLength(200);
    expect(inbox.truncated).toEqual({ held: true, drafts: true, running: false });
  });

  it("says when it can't list every thread running", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const now = world.timer.clock.now();
    const customers = Array.from({ length: 50 }, () => ({
      id: uuidv7(),
      userId: world.user.id,
      createdAt: now,
    }));
    await getTestDb().insert(representativeCustomer).values(customers);
    await getTestDb()
      .insert(representativeThread)
      .values(
        customers.map(({ id }) => ({
          id: uuidv7(),
          customerId: id,
          representativeId: world.id,
          lastChannel: fakeChannel,
          lastExternalId: first,
          createdAt: now,
          updatedAt: now,
        })),
      );

    const inbox = await world.rpc.representative.inbox();
    expect(inbox.running).toHaveLength(50);
    expect(inbox.truncated.running).toBe(true);
  });
});
