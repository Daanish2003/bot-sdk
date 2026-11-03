import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment, job } from "@botsdk/bot/storage";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { fakeChannel } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeThread } from "../src/server/db/schema";
import { takeoverNote } from "../src/server/takeover";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * A hand-off's result returns to its thread (ticket #1254): the Representative hands work to its
 * Bot, the Bot finishes it, and what it says for the Customer reaches them through a Turn, or the
 * owner, or neither. Fake Models and a fake Channel on real Postgres; the clock is the test's, and
 * jobs are claimed by hand.
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
const replies = (text: string) => round(toolCall({ name: "reply", input: { text } }));

const assignmentIdIn = (call: TextOptions) =>
  /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;
const finishes = (fields: Record<string, unknown>) => (call: TextOptions) =>
  round(
    toolCall({
      name: "run_tool",
      input: { name: "finish_assignment", args: { id: assignmentIdIn(call), ...fields } },
    }),
  );
const refunded = finishes({
  status: "done",
  outcome: "Refunded.",
  for_customer: "Your refund of 20 is on its way.",
});

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

async function serving(representativeRounds: Rounds, botRounds: Rounds = [refunded, quiet]) {
  const fake = createFakeAdapter({ rounds: representativeRounds });
  const botFake = createFakeAdapter({ rounds: botRounds });
  const timer = fakeJobClock(new Date());
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
    features: [representative()],
    adapterFor: (id) => (id === botModel ? botFake.adapter : (fake.adapter as AnyTextAdapter)),
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
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  const thread = async () => {
    const [summary] = await rpc.representative.threadList({ id });
    return rpc.representative.threadGet({ id: summary!.id });
  };
  /** Runs the next due job to its end, the batch window passed; whether there was one. */
  const runNext = async () => {
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    if (!claimed) return false;
    await jobs.runClaimed(claimed, {});
    return true;
  };
  return {
    fake,
    botFake,
    rpc,
    thread,
    botId,
    runNext,
    /** Runs every due job, the Bot's and the Representative's, until none is left. */
    drain: async () => {
      for (let tries = 0; tries < 30; tries += 1) if (!(await runNext())) return;
      throw new Error("The jobs never ran out");
    },
    send: async (message: string, proof?: { rule: "sameIdentity" }) =>
      receiveCustomerMessage(feature.context, {
        representativeId: id,
        channel: fakeChannel,
        externalId: number,
        message,
        proof,
      }),
  };
}

/** How many Turns the thread has had queued, running or done. */
const turnsOf = async (threadId: string) =>
  (
    await getTestDb()
      .select({ id: job.id })
      .from(job)
      .where(
        and(eq(job.name, "representative.turn"), sql`${job.payload}->>'threadId' = ${threadId}`),
      )
  ).length;

const texts = (messages: Array<{ text: string }>) => messages.map((message) => message.text);

describe("a hand-off's result", () => {
  it("wakes a Turn that tells the Customer, where they were last heard", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("Good news: your refund is on its way."),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    const { messages, waitingOn } = await thread();
    expect(messages).toEqual([
      expect.objectContaining({ author: "customer", text: "I want a refund" }),
      expect.objectContaining({
        author: "bot",
        text: "Your refund of 20 is on its way.",
        channel: fakeChannel,
        externalId: number,
      }),
      expect.objectContaining({
        author: "representative",
        text: "Good news: your refund is on its way.",
        channel: fakeChannel,
        externalId: number,
      }),
    ]);
    // The Turn that told the Customer read the result.
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain(
      "Your refund of 20 is on its way.",
    );
    expect(waitingOn).toBe("customer");
  });

  it("shows the Bot as who a thread waits on while the Assignment is open", async () => {
    const { send, runNext, drain, thread } = await serving([
      handsOff(),
      replies("I have asked."),
      quiet(),
      replies("Done."),
      quiet(),
    ]);
    await send("I want a refund");

    await runNext();
    expect(await thread()).toMatchObject({ waitingOn: "bot" });

    await drain();
    expect(await thread()).toMatchObject({ waitingOn: "customer" });
  });

  it("sends the Customer nothing when the result has no for_customer", async () => {
    const { fake, send, drain, thread } = await serving(
      [handsOff(), quiet()],
      [finishes({ status: "done", outcome: "Refunded." }), quiet],
    );
    await send("I want a refund");

    await drain();

    expect(fake.calls).toHaveLength(2);
    expect(texts((await thread()).messages)).toEqual(["I want a refund"]);
    const [assignment] = await getTestDb().select().from(botAssignment);
    expect(assignment).toMatchObject({ status: "done" });
  });

  it("goes to the owner during takeover: no Turn, nothing sent", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    await rpc.representative.threadTakeOver({ id: (await thread()).id });

    await drain();

    const held = await thread();
    expect(texts(held.messages)).toEqual([
      "I want a refund",
      takeoverNote,
      "Your refund of 20 is on its way.",
    ]);
    expect(held).toMatchObject({ holder: "owner", waitingOn: "owner" });
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(held.id)).toBe(1);

    // The owner decides what is sent.
    await rpc.representative.threadSend({ id: held.id, text: "It is coming." });
    expect(await thread()).toMatchObject({ waitingOn: "customer" });
    expect(fake.calls).toHaveLength(2);
  });

  it("is kept in a thread that has closed, and sends nothing", async () => {
    const { fake, send, runNext, drain, thread } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    const { id } = await thread();
    await getTestDb()
      .update(representativeThread)
      .set({ state: "closed" })
      .where(eq(representativeThread.id, id));

    await drain();

    const { messages, waitingOn } = await thread();
    expect(texts(messages)).toEqual(["I want a refund", "Your refund of 20 is on its way."]);
    expect(waitingOn).toBeNull();
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(id)).toBe(1);
  });

  it("is kept for the owner, and wakes no Turn, when the Customer is blocked", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    const { id, customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await drain();

    expect(texts((await thread()).messages)).toEqual([
      "I want a refund",
      "Your refund of 20 is on its way.",
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(id)).toBe(1);
  });

  it("goes back to the unverified sender it was handed off for, whom nothing moved", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("It is on its way."),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    const { messages } = await thread();
    expect(messages.map((message) => message.verified)).toEqual([false, false, false]);
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("Your refund of 20");
  });

  it("goes to a verified Customer where they were last heard, and the Turn labels it as the Bot's", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("It is on its way."),
      quiet(),
    ]);
    await send("I want a refund", { rule: "sameIdentity" });

    await drain();

    const { messages } = await thread();
    expect(messages.map((message) => message.verified)).toEqual([true, true, true]);
    expect(messages[2]).toMatchObject({ author: "representative", channel: fakeChannel });
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("written by the Bot");
  });
});
