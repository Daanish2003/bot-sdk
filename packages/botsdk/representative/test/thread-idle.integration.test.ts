import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeTurnJobName } from "../src/server/thread-turns";
import { threadIdleJobName, threadIdleMs } from "../src/server/idle";
import { handOffMessage } from "../src/server/replies";

/*
 * Threads close after 7 idle days (ticket #1252): a thread's own delayed job, run by a runner on a
 * fake clock over real Postgres, with a fake Model. What is stored is read through the owner's export.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;

type Exported = {
  representative: {
    customers: Array<{
      id: string;
      threads: Array<{ id: string; state: string; messages: Array<{ text: string }> }>;
    }>;
  };
};

const customersOf = async (deps: TestDeps, userId: string) =>
  ((await exportUserData(deps, userId)) as unknown as Exported).representative.customers;

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running feature instance whose runner's clock (starting at the real time, which the Turn's time limit reads) the test moves, with a Model that stays quiet. */
async function instance(first: Parameters<typeof createFakeAdapter>[0]["rounds"] = []) {
  const fake = createFakeAdapter({
    rounds: [...first, ...Array.from({ length: 20 }, () => round())],
  });
  const timer = fakeJobClock(new Date());
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
  });
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
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const say = (message: string) =>
    testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      message,
      externalId: "+15550001",
    });
  /** Moves the runner's clock on and has it claim what is now due. */
  const passTime = (ms: number) => {
    timer.advance(ms);
    timer.tick();
  };
  const idleChecks = () =>
    getTestDb()
      .select({ status: job.status, runAfter: job.runAfter })
      .from(job)
      .where(and(eq(job.name, threadIdleJobName)));
  return { deps, user, rpc, timer, say, passTime, idleChecks };
}

const threadsOf = async (deps: TestDeps, userId: string) =>
  (await customersOf(deps, userId)).flatMap((customer) => customer.threads);

describe("a thread's 7 idle days", () => {
  it("doesn't close while code's fixed message promises the Customer a follow-up, and the chain goes on", async () => {
    const guess = () =>
      round(
        toolCall({
          name: "reply",
          input: { topic: "general", text: "It is 10 USD.", kind: "answer" },
        }),
      );
    const { deps, user, say, passTime, idleChecks } = await instance([guess(), guess()]);
    await say("How much?");
    const state = async () => (await threadsOf(deps, user.id)).map((thread) => thread.state);
    await expect
      .poll(async () => (await threadsOf(deps, user.id))[0]?.messages.at(-1)?.text, poll)
      .toBe(handOffMessage);

    for (let week = 0; week < 3; week += 1) {
      passTime(8 * day);
      await expect
        .poll(
          async () => (await idleChecks()).filter((check) => check.status === "succeeded").length,
          poll,
        )
        .toBe(week + 1);
      expect(await state()).toEqual(["representative"]);
    }
    expect((await idleChecks()).some((check) => check.status === "queued")).toBe(true);

    // The Customer writes again and is answered: it closes as any thread does.
    await say("Hello?");
    await expect
      .poll(async () => (await threadsOf(deps, user.id))[0]?.messages.length, poll)
      .toBe(3);
    passTime(8 * day);
    await expect.poll(state, poll).toEqual(["closed"]);
  });

  it("closes a thread with no activity for 7 days", async () => {
    const { deps, user, say, passTime } = await instance();
    await say("Hello");
    expect((await threadsOf(deps, user.id)).map((thread) => thread.state)).toEqual([
      "representative",
    ]);

    passTime(threadIdleMs);

    await expect
      .poll(async () => (await threadsOf(deps, user.id)).map((thread) => thread.state), poll)
      .toEqual(["closed"]);
  });

  it("does not close it early, and activity pushes the close back by queueing the check again", async () => {
    const { deps, user, timer, say, passTime, idleChecks } = await instance();
    await say("Hello");

    passTime(6 * day);
    const spoke = timer.clock.now().getTime();
    await say("Still there?");
    passTime(day);

    // The check at day 7 found activity at day 6 and queued the next one for 7 days after it.
    await expect
      .poll(async () => (await idleChecks()).map((check) => check.status).sort(), poll)
      .toEqual(["queued", "succeeded"]);
    expect((await threadsOf(deps, user.id)).map((thread) => thread.state)).toEqual([
      "representative",
    ]);
    const next = (await idleChecks()).find((check) => check.status === "queued");
    expect(next?.runAfter.getTime()).toBe(spoke + 7 * day);

    passTime(6 * day);

    await expect
      .poll(async () => (await threadsOf(deps, user.id)).map((thread) => thread.state), poll)
      .toEqual(["closed"]);
  });

  it("gives a thread a blocked Customer opens its check too, with no Turn", async () => {
    const { deps, user, rpc, say, passTime, idleChecks } = await instance();
    await say("Hello");
    passTime(threadIdleMs);
    await expect
      .poll(async () => (await threadsOf(deps, user.id)).map((thread) => thread.state), poll)
      .toEqual(["closed"]);
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });

    await say("Blocked, and writing again");

    await expect
      .poll(async () => (await idleChecks()).filter(({ status }) => status === "queued"), poll)
      .toHaveLength(1);
    const turns = await getTestDb()
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.name, representativeTurnJobName), eq(job.status, "queued")));
    expect(turns).toEqual([]);
    passTime(threadIdleMs);
    await expect
      .poll(async () => (await threadsOf(deps, user.id)).map((thread) => thread.state), poll)
      .toEqual(["closed", "closed"]);
  });

  it("starts a new thread for the same Customer after closing, and keeps the old one readable", async () => {
    const { deps, user, say, passTime } = await instance();
    await say("First thread");
    passTime(threadIdleMs);
    await expect
      .poll(async () => (await threadsOf(deps, user.id)).map((thread) => thread.state), poll)
      .toEqual(["closed"]);

    await say("Back again");

    const customers = await customersOf(deps, user.id);
    expect(customers).toHaveLength(1);
    const threads = customers[0]!.threads;
    expect(threads.map((thread) => thread.state)).toEqual(["closed", "representative"]);
    expect(threads[0]?.messages.map((message) => message.text)).toEqual(["First thread"]);
    expect(threads[1]?.messages.map((message) => message.text)).toEqual(["Back again"]);
  });
});
