import type { AnyTextAdapter } from "@tanstack/ai";
import { noCustomerChannel } from "../src/server/customer-proof";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { type HostProvider, quotaLookup } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job, usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  promoteAutoTopic,
  testCustomerTurn,
  autoSource,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representative,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { limitCheckJobName, limitNote, reachLimit } from "../src/server/limits";
import { representativeFeature } from "../src/server/plugin";
import { unavailableNotice } from "../src/server/unavailable-notice";

/*
 * A Representative at a limit (ticket #1309), through the real Turn path: a fake Model on the Host's
 * credentials, real Postgres, a Customer channel over `fakeMessagingAdapter`. The Quota reads the real
 * time, not the SDK clock, so a test lifts it by raising the budget `getQuota` answers, and the runner's
 * clock moves the messages' age.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "anthropic:claude-sonnet-5-5";
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
const silent = { error: () => {} };
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const number = "+15550001";

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

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance with the owner's Quota spent. `lift` raises its budget and `spend` drops it. */
async function atQuota(rounds: Parameters<typeof createFakeAdapter>[0]["rounds"] = []) {
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
  const quota = { budgetUsd: 100, window: "month" as const };
  let quotaBroken = false;
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
    hostProviders,
    getQuota: quotaLookup(() => {
      if (quotaBroken) throw new Error("The Host's Quota can't be read");
      return quota;
    }),
  });
  made = deps;
  await jobs.start();
  runners.push(jobs);

  const user = await insertUser();
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId: user.id,
    kind: "representative",
    model,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 1_000_000,
    estimated: false,
    createdAt: new Date(),
  });
  quota.budgetUsd = 1;

  const world = Object.assign(deps, { timer });
  const thread = async () => (await rpc.representative.threadList({ id }))[0]!;
  const got = () => messaging.delivered.map(({ part }) => part);
  return {
    rpc,
    id,
    userId: user.id,
    timer,
    entered,
    got,
    thread,
    lift: () => {
      quota.budgetUsd = 100;
    },
    spend: () => {
      quota.budgetUsd = 0;
    },
    breakQuota: (broken: boolean) => {
      quotaBroken = broken;
    },
    setCaps: (caps: { maxInARow?: number; maxPerDay?: number }) =>
      getTestDb().update(representative).set(caps).where(eq(representative.id, id)),
    featureContext: () =>
      deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    /** A Customer's message, whose Turn runs to its end. */
    hears: (message: string, externalId = number) =>
      testCustomerTurn(world, { representativeId: id, externalId, message }),
    /** Moves the runner's clock on and has it claim what is due. */
    pass: (ms: number) => {
      timer.advance(ms);
      timer.tick();
    },
    /** Lets the runner get on with what is due, with the clock going forward as it would. */
    settle: async (done: () => Promise<boolean> | boolean) => {
      await expect
        .poll(
          async () => {
            timer.advance(5_000);
            timer.tick();
            return done();
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    },
    /** Gives every job due the time to run, for a test that something didn't happen. */
    runDue: async () => {
      timer.tick();
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    messages: async () =>
      getTestDb()
        .select({
          author: representativeThreadMessage.author,
          text: representativeThreadMessage.text,
        })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, (await thread()).id))
        .orderBy(asc(representativeThreadMessage.position)),
    decisions: async () =>
      getTestDb()
        .select({
          kind: representativeOutboundDecision.kind,
          outcome: representativeOutboundDecision.outcome,
          rule: representativeOutboundDecision.rule,
        })
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, (await thread()).id))
        .orderBy(asc(representativeOutboundDecision.id)),
  };
}

const delivered = async (world: { got: () => unknown[] }, count: number) =>
  expect.poll(() => world.got().length, { timeout: 10_000 }).toBe(count);

describe("a Representative with the Quota spent", () => {
  it("gives the Customer the fixed note through the gate, with no model call", async () => {
    const world = await atQuota();

    await world.hears("Hello");

    await delivered(world, 1);
    expect(world.got()).toEqual([limitNote]);
    expect(limitNote).toContain("Our team has your message and will reply");
    expect(world.entered).toEqual([]);
    expect(await world.decisions()).toEqual([
      { kind: "limit_note", outcome: "send", rule: "passed" },
    ]);
  });

  it("keeps the message owed, and the owner sees it", async () => {
    const world = await atQuota();

    await world.hears("Hello");

    expect(await world.messages()).toEqual([
      { author: "customer", text: "Hello" },
      { author: "representative", text: limitNote },
    ]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("gives a second message no second note, and keeps it too", async () => {
    const world = await atQuota();

    await world.hears("Hello");
    await delivered(world, 1);
    await world.hears("Anyone there?");
    await world.runDue();

    expect(world.got()).toEqual([limitNote]);
    expect(await world.decisions()).toHaveLength(1);
    expect((await world.messages()).map(({ text }) => text)).toEqual([
      "Hello",
      limitNote,
      "Anyone there?",
    ]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("Pages the owner once a day for the cause, however many threads reach it", async () => {
    const world = await atQuota();

    await world.hears("Hello");
    await world.hears("Me too", "+15550002");
    await world.hears("And again");

    const first = (await world.rpc.pages.list()).pages;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      cause: "quota_spent",
      urgency: "routine",
      path: `/representatives/${world.id}`,
    });

    world.timer.advance(day + 1);
    await world.hears("Still there?");

    expect((await world.rpc.pages.list()).pages).toHaveLength(2);
    expect(world.entered).toEqual([]);
  });

  it("does nothing more while the limit holds, however long it checks", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);

    for (let checks = 0; checks < 3; checks += 1) {
      world.pass(hour);
      await world.runDue();
    }

    expect(world.got()).toEqual([limitNote]);
    expect(world.entered).toEqual([]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });
});

describe("when the limit lifts", () => {
  it("answers a message under 24 hours old by itself", async () => {
    const world = await atQuota([replies("Hello, how can I help?"), round()]);
    await world.hears("Hello");
    await delivered(world, 1);

    world.pass(hour);
    await world.runDue();
    expect(world.entered).toEqual([]);

    world.lift();
    world.pass(hour);
    await world.settle(() => world.got().length === 2);

    expect(world.got()).toEqual([limitNote, "Hello, how can I help?"]);
    await world.settle(async () => (await world.thread()).waitingOn === "customer");
  });

  it("leaves an older message for the owner, with no automatic answer", async () => {
    const world = await atQuota([replies("Never sent")]);
    await world.hears("Hello");
    await delivered(world, 1);

    world.lift();
    world.pass(25 * hour);
    await world.runDue();
    world.pass(hour);
    await world.runDue();

    expect(world.entered).toEqual([]);
    expect(world.got()).toEqual([limitNote]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("answers only what is under 24 hours old when a new message finds it lifted", async () => {
    const world = await atQuota([replies("About the new one"), round()]);
    await world.hears("The old one");
    await delivered(world, 1);

    world.lift();
    world.timer.advance(25 * hour);
    await world.hears("The new one");
    await delivered(world, 2);

    expect(world.got()).toEqual([limitNote, "About the new one"]);
    // The old one reaches the Model as what was said, ahead of what it has to answer.
    const prompt = JSON.stringify(world.entered[0]);
    const old = prompt.indexOf("The old one");
    expect(old).toBeGreaterThan(-1);
    expect(old).toBeLessThan(prompt.indexOf("The new one"));
    // The old message is still the owner's.
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("is off the thread as soon as a new message's Turn gets past it", async () => {
    const world = await atQuota([replies("About the new one"), round()]);
    await world.hears("Hello");
    await delivered(world, 1);

    world.lift();
    await world.hears("Still there?");
    await delivered(world, 2);

    expect(world.got()).toEqual([limitNote, "About the new one"]);
    expect((await world.thread()).waitingOn).toBe("customer");
  });

  it("gives a later limit a note of its own", async () => {
    const world = await atQuota([replies("Hello, how can I help?"), round()]);
    await world.hears("Hello");
    await delivered(world, 1);
    world.lift();
    world.pass(hour);
    await world.settle(() => world.got().length === 2);
    await world.settle(async () => (await world.thread()).waitingOn === "customer");

    world.spend();
    await world.hears("One more thing");

    await delivered(world, 3);
    expect(world.got()).toEqual([limitNote, "Hello, how can I help?", limitNote]);
  });
});

describe("the note and the gate", () => {
  it("goes out over a cap, and as a note, not as a draft", async () => {
    const world = await atQuota();
    await world.setCaps({ maxInARow: 0, maxPerDay: 0 });
    await world.hears("Hello");

    await delivered(world, 1);
    expect(world.got()).toEqual([limitNote]);
    expect(await world.decisions()).toEqual([
      { kind: "limit_note", outcome: "send", rule: "passed" },
    ]);
  });

  it("counts against no cap once the limit lifts", async () => {
    const world = await atQuota([replies("Hello, how can I help?"), round()]);
    await world.setCaps({ maxInARow: 1, maxPerDay: 1 });
    await world.hears("Hello");
    await delivered(world, 1);

    world.lift();
    world.pass(hour);
    await world.settle(() => world.got().length === 2);

    expect(world.got()).toEqual([limitNote, "Hello, how can I help?"]);
  });
});

describe("the owner, at a limit", () => {
  it("clears what is left for them by sending a draft in their own words", async () => {
    const world = await atQuota([drafts("About the new one"), round()]);
    await world.hears("The old one");
    await delivered(world, 1);

    world.lift();
    world.timer.advance(25 * hour);
    await world.hears("The new one");
    await world.settle(async () => (await world.rpc.representative.replyDraftList()).length === 1);
    const [draft] = await world.rpc.representative.replyDraftList();
    expect((await world.thread()).waitingOn).toBe("owner");
    await world.rpc.representative.replyDraftEdit({ id: draft!.id, text: "About both" });

    await world.settle(() => world.got().includes("About both"));
    await world.settle(async () => (await world.thread()).waitingOn === "customer");
  });

  it("clears what is left for them by taking the thread over and answering", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);
    world.lift();
    world.pass(25 * hour);
    await world.runDue();

    const { id } = await world.thread();
    await world.rpc.representative.threadTakeOver({ id });
    await world.rpc.representative.threadSend({ id, text: "Sorry for the wait" });
    await world.rpc.representative.threadHandBack({ id });

    expect((await world.thread()).waitingOn).toBe("customer");
    world.pass(hour);
    await world.runDue();
    expect(world.entered).toEqual([]);
  });

  it("still owes what was left for them after only taking the thread over", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);
    world.lift();
    world.pass(25 * hour);
    await world.runDue();

    await world.rpc.representative.threadTakeOver({ id: (await world.thread()).id });
    expect((await world.thread()).waitingOn).toBe("owner");

    await world.rpc.representative.threadHandBack({ id: (await world.thread()).id });
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("gets no second note for taking over and handing back at the same limit", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);
    const { id } = await world.thread();

    await world.rpc.representative.threadTakeOver({ id });
    await delivered(world, 2);
    await world.rpc.representative.threadHandBack({ id });
    await world.settle(async () => (await world.thread()).waitingOn === "owner");
    await world.runDue();

    expect(world.got().filter((text) => text === limitNote)).toHaveLength(1);
    expect(world.entered).toEqual([]);
  });

  it("gets no automatic answer to an old message by handing back after the limit lifts", async () => {
    const world = await atQuota([replies("Never sent")]);
    await world.hears("Hello");
    await delivered(world, 1);
    const { id } = await world.thread();
    await world.rpc.representative.threadTakeOver({ id });

    world.lift();
    world.timer.advance(25 * hour);
    await world.rpc.representative.threadHandBack({ id });
    world.pass(hour);
    await world.runDue();

    expect(world.entered).toEqual([]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("owes nothing after answering at the limit and handing back", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);
    const { id } = await world.thread();

    await world.rpc.representative.threadTakeOver({ id });
    await world.rpc.representative.threadSend({ id, text: "I can help" });
    await world.rpc.representative.threadHandBack({ id });

    expect((await world.thread()).waitingOn).toBe("customer");
  });

  it("isn't answered over: a thread they hold gets no Turn when the limit lifts", async () => {
    const world = await atQuota([replies("The answer"), round()]);
    await world.hears("Hello");
    await delivered(world, 1);
    await world.rpc.representative.threadTakeOver({ id: (await world.thread()).id });
    await delivered(world, 2);

    world.lift();
    world.pass(hour);
    await world.runDue();
    world.pass(minute);
    await world.runDue();

    expect(world.entered).toEqual([]);
    expect(await world.decisions()).toHaveLength(2);

    // It is still waiting, so Hand back has a Turn answer it.
    await world.rpc.representative.threadHandBack({ id: (await world.thread()).id });
    await world.settle(() => world.got().includes("The answer"));
  });

  it("keeps what a switched-off Representative's Turn took, and it is answered after", async () => {
    const world = await atQuota([replies("Hello, how can I help?"), round()]);
    await world.hears("Hello");
    await delivered(world, 1);

    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    await world.hears("Anyone there?");
    expect((await world.thread()).waitingOn).toBe("owner");

    await world.rpc.representative.setEnabled({ id: world.id, enabled: true });
    world.lift();
    world.pass(hour);
    await world.settle(() => world.got().length === 3);
    // The Customer was told nobody could answer, and a late answer is better than none (ticket #1332).
    expect(world.got()).toEqual([limitNote, unavailableNotice, "Hello, how can I help?"]);
    const prompt = JSON.stringify(world.entered[0]);
    expect(prompt).toContain("Hello");
    expect(prompt).toContain("Anyone there?");
  });

  it("tries the note again when the gate refused it", async () => {
    const world = await atQuota();
    // A Turn holding a thread of this Customer's, not yet at any limit.
    await world.hears("Hello");
    await delivered(world, 1);
    const { id } = await world.thread();
    const turnId = uuidv7();
    await getTestDb()
      .update(representativeThread)
      .set({ limitNotedAt: null, turnId, waitingFrom: 1 })
      .where(eq(representativeThread.id, id));
    const context = { ...world.featureContext(), channel: noCustomerChannel } as Parameters<
      typeof reachLimit
    >[0];
    const reach = () =>
      getTestDb().transaction((tx) =>
        reachLimit(context, tx, {
          userId: world.userId,
          representativeId: world.id,
          turnId,
          thread: {
            threadId: id,
            upTo: 1,
            heard: { channel: "fake", externalId: number },
            verified: false,
            releaseId: uuidv7(),
            refusals: [],
          },
          cause: "quota_spent",
          now: world.timer.clock.now(),
        }),
      );

    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    await reach();
    await world.runDue();
    expect(world.got()).toEqual([limitNote]);

    await world.rpc.representative.setEnabled({ id: world.id, enabled: true });
    await reach();
    await delivered(world, 2);
  });

  it("keeps a thread's chain through a check that fails for good", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);
    const checks = (status: "failed" | "queued") =>
      getTestDb()
        .select({ id: job.id })
        .from(job)
        .where(and(eq(job.name, limitCheckJobName), eq(job.status, status)));

    world.breakQuota(true);
    await expect
      .poll(
        async () => {
          world.pass(6 * hour);
          return (await checks("failed")).length;
        },
        { timeout: 20_000, interval: 200 },
      )
      .toBeGreaterThan(0);
    expect((await checks("queued")).length).toBeGreaterThan(0);

    world.breakQuota(false);
    world.lift();
    // The chain carries on and finds it lifted, which ends it. The message is too old by now.
    world.pass(hour);
    await world.settle(async () => (await checks("queued")).length === 0);
  });

  it("finds the thread still open: a limit's thread doesn't close for being idle", async () => {
    const world = await atQuota();
    await world.hears("Hello");
    await delivered(world, 1);

    world.pass(8 * day);
    await world.runDue();
    expect((await world.thread()).holder).toBe("representative");

    world.lift();
    world.pass(hour);
    await world.runDue();
    world.pass(8 * day);
    await world.runDue();
    expect((await world.thread()).holder).toBe("representative");
    expect((await world.thread()).waitingOn).toBe("owner");
  });
});
