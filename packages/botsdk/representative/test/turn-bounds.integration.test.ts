import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment, job } from "@botsdk/bot/storage";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { fakeChannel, promoteAutoTopic, autoSource } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representativeThread } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * A Representative Turn is bounded (ticket #1299): one hand-off per Turn, a limit on the Bot and
 * Representative loop, a Ban that stops it and starts none, and a Bot pause that leaves it alone.
 * Fake Models on real Postgres; the clock is the test's, and jobs are claimed by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const number = "+15550001";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const quiet = () => round();
const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );
const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );

const assignmentIdIn = (call: TextOptions) =>
  [
    ...JSON.stringify(call.messages.slice(1)).matchAll(/Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/g),
  ].at(-1)![1]!;
const refunded = (call: TextOptions) =>
  round(
    toolCall({
      name: "run_tool",
      input: {
        name: "finish_assignment",
        args: {
          id: assignmentIdIn(call),
          status: "done",
          outcome: "Refunded.",
          for_customer: "Your refund of 20 is on its way.",
        },
      },
    }),
  );

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

// The test claims jobs by hand: none another test left behind may be claimed first.
beforeEach(async () => {
  await getTestDb()
    .update(job)
    .set({ status: "cancelled" })
    .where(inArray(job.status, ["queued", "running"]));
});

async function serving(
  representativeRounds: Rounds,
  { botRounds = [refunded, quiet], held }: { botRounds?: Rounds; held?: Promise<void> } = {},
) {
  const fake = createFakeAdapter({ rounds: representativeRounds });
  const entered: unknown[] = [];
  const gated: AnyTextAdapter = {
    ...(fake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      entered.push(options);
      await held;
      yield* fake.adapter.chatStream(options);
    },
  };
  const botFake = createFakeAdapter({ rounds: botRounds });
  const timer = fakeJobClock(new Date());
  const ban = { on: false };
  let made: ReturnType<typeof createTestSdk> | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 1_000,
    jobs: () => made!.parts.jobs,
  });
  runners.push(jobs);
  const deps = createTestSdk({
    jobs,
    clock: timer.clock.now,
    features: [representativeFeature()],
    users: { isBlocked: async () => ban.on },
    adapterFor: (id) => (id === botModel ? botFake.adapter : gated),
    memory: false,
  });
  made = deps;
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "...-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model,
      tools: ["reply", "hand_to_bot"],
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  await promoteAutoTopic(id);
  const runNext = async () => {
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    if (!claimed) return false;
    await jobs.runClaimed(claimed, {});
    return true;
  };
  return {
    deps,
    user,
    jobs,
    timer,
    entered,
    fake,
    rpc,
    botId,
    ban,
    runNext,
    thread: async () => {
      const [summary] = await rpc.representative.threadList({ id });
      return rpc.representative.threadGet({ id: summary!.id });
    },
    /** Runs every due job, the Bot's and the Representative's, until none is left. */
    drain: async () => {
      for (let tries = 0; tries < 40; tries += 1) if (!(await runNext())) return;
      throw new Error("The jobs never ran out");
    },
    send: async (message: string) => {
      await promoteAutoTopic(id);
      return receiveCustomerMessage(feature.context, {
        representativeId: id,
        channel: fakeChannel,
        externalId: number,
        message,
      });
    },
  };
}

const assignmentsOf = (botId: string) =>
  getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId));

/** The Representative Turn's job on a thread. */
const turnJobs = (threadId: string) =>
  getTestDb()
    .select({ status: job.status })
    .from(job)
    .where(
      and(eq(job.name, "representative.turn"), sql`${job.payload}->>'threadId' = ${threadId}`),
    );

/** What the Bot says for `count` hand-offs, one after another. */
const bot = (count: number) => Array.from({ length: count }, () => [refunded, quiet]).flat();

/** A Turn that hands off and ends. */
const handsOffAndEnds = (count: number) =>
  Array.from({ length: count }, () => [handsOff(), quiet()]).flat();

describe("a Representative's hand-off cap", () => {
  it("refuses a second hand_to_bot in a Turn, tells the Model why, and opens no second Assignment", async () => {
    const { fake, send, drain, botId } = await serving([handsOff(), handsOff(), quiet(), quiet()]);
    await send("I want a refund");

    await drain();

    expect(await assignmentsOf(botId)).toHaveLength(1);
    // The Model's third call heard the refusal of its second hand-off.
    expect(JSON.stringify(fake.calls[2]!.messages)).toContain("already handed off this Turn");
  });
});

describe("a Representative's hand-off cap, with calls in one Model response", () => {
  it("opens one Assignment when the Model calls hand_to_bot twice at once", async () => {
    const { send, drain, botId } = await serving([
      round(
        toolCall({ name: "hand_to_bot", input: { title: "A refund", instructions: "One." } }),
        toolCall({ name: "hand_to_bot", input: { title: "A refund", instructions: "Two." } }),
      ),
      quiet(),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    expect(await assignmentsOf(botId)).toHaveLength(1);
  });
});

describe("the Bot and Representative loop", () => {
  it("stops at 3 hand-offs with no Customer message between them", async () => {
    const { fake, send, drain, botId } = await serving(handsOffAndEnds(4), {
      botRounds: bot(4),
    });
    await send("I want a refund");

    await drain();

    expect(await assignmentsOf(botId)).toHaveLength(3);
    // The fourth Turn tried, and heard why not.
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("reached the limit");
  });

  it("starts the count again at a Customer message", async () => {
    const { send, drain, botId } = await serving(handsOffAndEnds(5), { botRounds: bot(5) });
    await send("I want a refund");
    await drain();
    expect(await assignmentsOf(botId)).toHaveLength(3);

    await send("Hello? Still waiting");
    await drain();

    expect(await assignmentsOf(botId)).toHaveLength(4);
  });
});

describe("a Ban", () => {
  it("stops a running Representative Turn", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const { entered, jobs, timer, send, thread, deps, user, botId } = await serving(
      [handsOff(), quiet()],
      { held },
    );
    await send("I want a refund");
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    const attempt = jobs.runClaimed(claimed!, {});
    await vi.waitFor(() => expect(entered).toHaveLength(1), { timeout: 10_000 });
    const { id } = await thread();

    await deps.bots.stopTurns({ userId: user.id });

    expect(await turnJobs(id)).toEqual([{ status: "cancelled" }]);
    open();
    await attempt;
    expect(entered).toHaveLength(1);
    expect(await assignmentsOf(botId)).toEqual([]);
    const [row] = await getTestDb()
      .select({ turnId: representativeThread.turnId })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    expect(row?.turnId).toBeNull();
  });

  it("starts no Representative Turn while it lasts", async () => {
    const { entered, send, drain, ban, thread, botId } = await serving([handsOff(), quiet()]);
    ban.on = true;
    await send("I want a refund");

    await drain();

    expect(entered).toEqual([]);
    expect(await assignmentsOf(botId)).toEqual([]);
    // The message is kept, and the thread isn't left holding a Turn.
    const { messages, id } = await thread();
    expect(messages).toHaveLength(1);
    const [row] = await getTestDb()
      .select({ turnId: representativeThread.turnId })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    expect(row?.turnId).toBeNull();
  });
});

describe("pausing the Bot a Representative reports to", () => {
  it("doesn't stop the Representative's Turn", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const { entered, jobs, timer, send, thread, rpc, botId } = await serving(
      [replies("One moment."), quiet()],
      { held },
    );
    await send("Hello");
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    const attempt = jobs.runClaimed(claimed!, {});
    await vi.waitFor(() => expect(entered).toHaveLength(1), { timeout: 10_000 });

    await rpc.bots.pause({ botId });
    open();
    await attempt;

    const { messages } = await thread();
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({ author: "representative", text: "One moment." }),
    );
  });
});
