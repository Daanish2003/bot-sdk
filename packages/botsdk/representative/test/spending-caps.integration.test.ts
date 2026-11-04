import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { type HostProvider, quotaLookup } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { promoteAutoTopic, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representativeThread,
  representativeThreadMessage,
  representativeTurn,
} from "../src/server/db/schema";
import { limitNote } from "../src/server/limits";
import { representativeFeature } from "../src/server/plugin";
import type { SpendingCaps } from "../src/shared/contract";

/*
 * What a Representative may cost (ticket #1310), through the real Turn path: a fake Model on the Host's
 * credentials, real Postgres, a Customer channel over `fakeMessagingAdapter`, and the SDK's fake clock.
 * Spending a test didn't make through a Turn is seeded as usage rows, which is what a cap counts.
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
  round(toolCall({ name: "reply", input: { text, kind: "small_talk", topic: "general" } }));

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

type Spend = {
  calls?: number;
  /** The money all the calls cost together. */
  micros?: number;
  at?: Date;
  kind?: "representative" | "turn" | "customer_memory";
};

/** A running instance with a Representative on, and its caps at the defaults. */
async function instance(
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"] = [],
  startAt = new Date(),
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
    sendProof: async () => {},
  };
  const timer = fakeJobClock(startAt);
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
    getQuota: quotaLookup(() => ({ budgetUsd: 1_000_000, window: "month" })),
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

  const world = Object.assign(deps, { timer });
  const thread = async () => (await rpc.representative.threadList({ id }))[0]!;
  const got = () => messaging.delivered.map(({ part }) => part);
  const threadId = async () => {
    const [row] = await getTestDb()
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .where(eq(representativeThread.representativeId, id));
    return row!.id;
  };
  const insertUsage = async (sourceId: string, spend: Spend) => {
    const { calls = 1, micros = 0, at = timer.clock.now(), kind = "representative" } = spend;
    await getTestDb()
      .insert(usage)
      .values(
        Array.from({ length: calls }, () => ({
          id: uuidv7(),
          userId: user.id,
          kind,
          model,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: Math.floor(micros / calls),
          estimated: false,
          sourceId,
          createdAt: at,
        })),
      );
  };
  return {
    rpc,
    id,
    userId: user.id,
    timer,
    entered,
    got,
    thread,
    threadId,
    insertUsage,
    /** Model calls a Turn of this thread made: what a thread's and a Customer's caps count. */
    spendOnTurn: async (forThread: string, spend: Spend) => {
      const turnId = uuidv7();
      await getTestDb()
        .insert(representativeTurn)
        .values({ id: turnId, threadId: forThread, representativeId: id });
      await insertUsage(turnId, spend);
    },
    setCaps: (caps: Partial<SpendingCaps>) => rpc.representative.setSpendingCaps({ id, ...caps }),
    /** A verified Customer's message (or an unverified one's), whose Turn runs to its end. */
    hears: (message: string, { stranger = false, externalId = number } = {}) =>
      testCustomerTurn(world, {
        representativeId: id,
        externalId,
        message,
        ...(!stranger && { proof: { rule: "sameIdentity" as const } }),
      }),
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
    pages: async () => (await rpc.pages.list()).map(({ cause }) => cause),
    messages: async () =>
      getTestDb()
        .select({
          author: representativeThreadMessage.author,
          text: representativeThreadMessage.text,
        })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, await threadId()))
        .orderBy(asc(representativeThreadMessage.position)),
  };
}

const delivered = async (world: { got: () => unknown[] }, count: number) =>
  expect.poll(() => world.got().length, { timeout: 10_000 }).toBe(count);

/** A world whose verified Customer has written once and been answered, so its thread exists. */
async function afterFirstAnswer(startAt?: Date) {
  const world = await instance(
    [replies("Hello, how can I help?"), round(), replies("Second"), round(), round()],
    startAt,
  );
  await world.hears("Hello");
  await delivered(world, 1);
  return world;
}

describe("the thread cap", () => {
  it("stops the next Turn at its model-call limit, with the fixed note and no call", async () => {
    const world = await instance([replies("Hello, how can I help?"), round()]);
    await world.setCaps({ threadCalls: 2 });
    await world.hears("Hello");
    await delivered(world, 1);
    expect(world.entered).toHaveLength(2);

    await world.hears("And another thing");

    await delivered(world, 2);
    expect(world.got()).toEqual(["Hello, how can I help?", limitNote]);
    expect(world.entered).toHaveLength(2);
    expect(await world.pages()).toEqual(["thread_cap"]);
  });

  it("stops the next Turn at its money limit", async () => {
    const world = await afterFirstAnswer();
    await world.spendOnTurn(await world.threadId(), { micros: 500_000 });
    const before = world.entered.length;

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe(limitNote);
    expect(world.entered).toHaveLength(before);
    expect(await world.pages()).toEqual(["thread_cap"]);
  });

  it("ends a Turn that reaches it before its next model call", async () => {
    const world = await instance([replies("Hello, how can I help?"), round()]);
    await world.setCaps({ threadCalls: 1 });

    await world.hears("Hello");

    await delivered(world, 2);
    expect(world.entered).toHaveLength(1);
    expect(world.got()).toEqual(["Hello, how can I help?", limitNote]);
    expect(await world.pages()).toEqual(["thread_cap"]);
  });

  it("goes on below the limit", async () => {
    const world = await afterFirstAnswer();
    await world.spendOnTurn(await world.threadId(), { calls: 20, micros: 100_000 });

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
  });
});

describe("the Customer cap", () => {
  it("stops the next Turn at its model-call limit, over all the Customer's threads", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 1000 });
    await world.spendOnTurn(await world.threadId(), { calls: 60 });
    const before = world.entered.length;

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe(limitNote);
    expect(world.entered).toHaveLength(before);
    expect(await world.pages()).toEqual(["customer_cap"]);
  });

  it("stops at its money limit", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadMicros: 1_000_000_000 });
    await world.spendOnTurn(await world.threadId(), { micros: 2_000_000 });

    await world.hears("More?");

    await delivered(world, 2);
    expect(await world.pages()).toEqual(["customer_cap"]);
  });

  it("counts only the last day, so a later day lifts it and the message is answered", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 1000 });
    await world.spendOnTurn(await world.threadId(), {
      calls: 60,
      at: new Date(world.timer.clock.now().getTime() - 23 * hour),
    });
    await world.hears("More?");
    await delivered(world, 2);

    world.pass(2 * hour);
    await world.settle(() => world.got().length === 3);

    expect(world.got()).toEqual(["Hello, how can I help?", limitNote, "Second"]);
  });
});

describe("an unverified Customer", () => {
  it("stops at the lower cap, at a spend a verified Customer goes on from", async () => {
    const world = await afterFirstAnswer();
    await world.spendOnTurn(await world.threadId(), { calls: 25 });
    await world.hears("Still me", { externalId: number });
    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");

    const stranger = await instance([replies("Hello"), round(), round()]);
    await stranger.hears("Hello", { stranger: true });
    await stranger.spendOnTurn(await stranger.threadId(), { calls: 25 });
    const before = stranger.entered.length;
    await stranger.hears("Hello?", { stranger: true });

    await expect.poll(async () => (await stranger.pages()).length, { timeout: 10_000 }).toBe(1);
    expect(await stranger.pages()).toEqual(["stranger_cap"]);
    expect(stranger.entered).toHaveLength(before);
  });

  it("stops at the lower money limit", async () => {
    const world = await instance([replies("Hello"), round(), round()]);
    await world.setCaps({ threadMicros: 1_000_000_000 });
    await world.hears("Hello", { stranger: true });
    await world.spendOnTurn(await world.threadId(), { micros: 500_000 });

    await world.hears("Hello?", { stranger: true });

    await expect
      .poll(async () => await world.pages(), { timeout: 10_000 })
      .toEqual(["stranger_cap"]);
  });
});

describe("the monthly cap", () => {
  it("counts the Representative's Turns and Customer memory across all its Customers", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ monthMicros: 3_000_000 });
    const threadId = await world.threadId();
    // Another Customer's Turn, and a memory pass: neither is this thread's or this Customer's spend.
    await world.hears("Me too", { externalId: "+15550002" });
    await delivered(world, 2);
    const other = await world.rpc.representative.threadList({ id: world.id });
    const otherThread = other.find((each) => each.id !== threadId)!;
    await world.spendOnTurn(otherThread.id, { micros: 1_900_000 });
    await world.insertUsage(threadId, { kind: "customer_memory", micros: 1_100_000 });
    const before = world.entered.length;

    await world.hears("More?");

    await delivered(world, 3);
    expect(world.got().at(-1)).toBe(limitNote);
    expect(world.entered).toHaveLength(before);
    expect(await world.pages()).toEqual(["month_cap"]);
  });

  it("counts only this Representative's spend, not another of the owner's", async () => {
    const world = await afterFirstAnswer();
    // The other thread is the same Customer's, so its spend must not reach the Customer's own cap either.
    await world.setCaps({ monthMicros: 3_000_000, customerMicros: 1_000_000_000 });
    const second = await world.rpc.representative.create({ name: "Back office" });
    const [firstThread] = await getTestDb().select().from(representativeThread);
    // A thread and a Turn of the other Representative, with more spend than this one's cap.
    const otherThread = uuidv7();
    await getTestDb().insert(representativeThread).values({
      id: otherThread,
      customerId: firstThread!.customerId,
      representativeId: second.id,
      lastChannel: "fake",
      lastExternalId: "other",
    });
    const turnId = uuidv7();
    await getTestDb()
      .insert(representativeTurn)
      .values({ id: turnId, threadId: otherThread, representativeId: second.id });
    await world.insertUsage(turnId, { micros: 9_000_000 });

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
    expect(await world.pages()).toEqual([]);
  });

  it("does nothing more while the cap holds, however long it checks", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 2 });
    await world.hears("More?");
    await delivered(world, 2);
    const before = world.entered.length;

    for (let checks = 0; checks < 3; checks += 1) {
      world.pass(hour);
      await world.runDue();
    }

    expect(world.entered).toHaveLength(before);
    expect(world.got()).toEqual(["Hello, how can I help?", limitNote]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("is lifted by the next month, and the message is answered", async () => {
    const world = await afterFirstAnswer(new Date("2026-11-30T20:00:00.000Z"));
    await world.setCaps({ monthMicros: 1_000_000, threadMicros: 1_000_000_000 });
    await world.spendOnTurn(await world.threadId(), { micros: 1_000_000 });
    await world.hears("More?");
    await delivered(world, 2);

    world.pass(5 * hour);
    await world.settle(() => world.got().length === 3);

    expect(world.got()).toEqual(["Hello, how can I help?", limitNote, "Second"]);
  });

  it("is lifted in the new month's first Turn too, with no check in between", async () => {
    const world = await afterFirstAnswer(new Date("2026-11-30T23:30:00.000Z"));
    await world.setCaps({ monthMicros: 1_000_000, threadMicros: 1_000_000_000 });
    await world.spendOnTurn(await world.threadId(), { micros: 1_000_000 });
    world.timer.advance(2 * hour);

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
  });
});

describe("what a cap counts", () => {
  it("counts Customer memory toward the month and not toward the thread or the Customer", async () => {
    const world = await afterFirstAnswer();
    await world.insertUsage(await world.threadId(), {
      kind: "customer_memory",
      calls: 100,
      micros: 1_000_000,
    });

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
  });

  it("counts a test conversation toward none", async () => {
    const world = await afterFirstAnswer();
    // A test conversation's calls are billed to its result, which is no Turn.
    await world.insertUsage(uuidv7(), { calls: 1000, micros: 100_000_000 });

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
  });

  it("counts an Assignment's spending toward none", async () => {
    const world = await afterFirstAnswer();
    const threadId = await world.threadId();
    // A Bot working an Assignment bills its Turns as `turn`, even under a Turn id the thread kept.
    await world.spendOnTurn(threadId, { kind: "turn", calls: 1000, micros: 100_000_000 });

    await world.hears("More?");

    await delivered(world, 2);
    expect(world.got().at(-1)).toBe("Second");
  });
});

describe("the owner editing the caps", () => {
  it("shows each cap and the month's use", async () => {
    const world = await instance();
    const edited = await world.setCaps({ threadCalls: 7, monthMicros: 4_000_000 });
    expect(edited.spendingCaps).toEqual({
      threadCalls: 7,
      threadMicros: 500_000,
      customerCalls: 60,
      customerMicros: 2_000_000,
      strangerCalls: 20,
      strangerMicros: 500_000,
      monthMicros: 4_000_000,
    });
    expect(edited.monthUsedPercent).toBe(0);
    expect((await world.rpc.representative.get({ id: world.id })).spendingCaps).toEqual(
      edited.spendingCaps,
    );
  });

  it("rejects an edit that gives no cap, or one that is not a whole positive number", async () => {
    const world = await instance();
    await expect(world.rpc.representative.setSpendingCaps({ id: world.id })).rejects.toThrow();
    await expect(world.setCaps({ threadCalls: 0 })).rejects.toThrow();
    await expect(world.setCaps({ monthMicros: 1.5 })).rejects.toThrow();
  });

  it("reports the share of the monthly cap used", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ monthMicros: 1_000_000 });
    await world.spendOnTurn(await world.threadId(), { micros: 850_000 });

    expect((await world.rpc.representative.get({ id: world.id })).monthUsedPercent).toBe(85);
  });

  it("lifts the limit by a raise, and a message under 24 hours old is answered", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 2 });
    await world.hears("More?");
    await delivered(world, 2);
    expect(world.got().at(-1)).toBe(limitNote);

    await world.setCaps({ threadCalls: 100 });
    await world.settle(() => world.got().length === 3);

    expect(world.got().at(-1)).toBe("Second");
  });

  it("leaves a message over 24 hours old for the owner after a raise", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 2 });
    await world.hears("More?");
    await delivered(world, 2);
    const before = world.entered.length;

    world.timer.advance(day + hour);
    await world.setCaps({ threadCalls: 100 });
    await world.runDue();

    expect(world.entered).toHaveLength(before);
    expect(world.got()).toEqual(["Hello, how can I help?", limitNote]);
    expect((await world.thread()).waitingOn).toBe("owner");
  });

  it("does not lift a limit by a raise of another cap", async () => {
    const world = await afterFirstAnswer();
    await world.setCaps({ threadCalls: 2 });
    await world.hears("More?");
    await delivered(world, 2);
    const before = world.entered.length;

    await world.setCaps({ customerCalls: 500 });
    await world.runDue();

    expect(world.entered).toHaveLength(before);
    expect(world.got()).toEqual(["Hello, how can I help?", limitNote]);
  });
});
