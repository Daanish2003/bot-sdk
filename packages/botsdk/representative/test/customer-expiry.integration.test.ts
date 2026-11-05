import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { answersOnce, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import type { TextOptions } from "@tanstack/ai";
import { representative } from "../src";
import {
  representativeCustomerSummary,
  representativeHandOff,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { customerSummaryMarker } from "../src/server/customer-summary";
import { queueThreadExpiry, threadExpiryJobName, threadExpiryMs } from "../src/server/expiry";
import { threadIdleMs } from "../src/server/idle";

/*
 * Customer threads expire (ticket #1285): 12 months after a thread closes, its row, messages and
 * summary go; profiles stay. Driven by a real runner on a fake clock over real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const isPassCall = (options: TextOptions) =>
  JSON.stringify(options.systemPrompts ?? []).includes(customerSummaryMarker);

const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );

async function instance({
  turnRounds = [],
}: { turnRounds?: Array<() => ReturnType<typeof round>> } = {}) {
  const turns = [...turnRounds];
  const fake = createFakeAdapter({
    rounds: Array.from({ length: 40 }, () => (options: TextOptions) => {
      if (isPassCall(options)) return round(text("Asked about hours."));
      return turns.shift()?.() ?? answersOnce(options);
    }),
  });
  const botFake = createFakeAdapter({ rounds: [round()] });
  const timer = fakeJobClock(new Date());
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    clock: timer.clock,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: (id) => (id === botModel ? botFake.adapter : fake.adapter),
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
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "hand_to_bot"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  // No quiet hours: a hand-off's overdue note is the business speaking unprompted, and the real clock may be night.
  await rpc.representative.setQuietHours({ id, startHour: 0, endHour: 0, timeZone: "UTC" });
  const say = (message: string, externalId = "+15550001") =>
    testCustomerTurn(Object.assign(deps, { timer }), { representativeId: id, message, externalId });
  /** Moves the clock and fires the runner's timers. */
  const passTime = (ms: number) => {
    timer.advance(ms);
    timer.tick();
  };
  /** Every job due by the fake clock has ended. */
  const settle = () =>
    expect
      .poll(async () => {
        timer.tick();
        const rows = await getTestDb()
          .select({ status: job.status, runAfter: job.runAfter })
          .from(job);
        return rows.filter(
          (row) => ["queued", "running"].includes(row.status) && row.runAfter <= timer.clock.now(),
        ).length;
      }, poll)
      .toBe(0);
  const threadRows = (threadId: string) =>
    getTestDb()
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .where(eq(representativeThread.id, threadId));
  const messageRows = (threadId: string) =>
    getTestDb()
      .select({ id: representativeThreadMessage.id })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, threadId));
  const summaryRows = (threadId: string) =>
    getTestDb()
      .select({ id: representativeCustomerSummary.id })
      .from(representativeCustomerSummary)
      .where(eq(representativeCustomerSummary.threadId, threadId));
  const threadsOf = () => rpc.representative.threadList({ id });
  /** Says hello, lets the thread go idle and close with its summary written, and returns its id. */
  const closedThread = async (message = "When do you open?") => {
    await say(message);
    await expect.poll(async () => (await threadsOf()).length, poll).toBe(1);
    const [thread] = await threadsOf();
    await expect
      .poll(async () => {
        passTime(1_000);
        const turns = await getTestDb()
          .select({ status: job.status })
          .from(job)
          .where(eq(job.name, "representative.turn"));
        return turns.length > 0 && turns.every((turn) => turn.status === "succeeded");
      }, poll)
      .toBe(true);
    // A hand-off's Assignment that nobody ends is overdue at 30 minutes, and the note it sends is
    // activity: let that come due on time, not after the idle days.
    passTime(31 * 60_000);
    await settle();
    passTime(threadIdleMs + 60_000);
    await expect
      .poll(async () => {
        passTime(1_000);
        return (await summaryRows(thread!.id)).length;
      }, poll)
      .toBe(1);
    await settle();
    return thread!.id;
  };
  /** Two Customers with an open thread each. */
  const twoCustomers = async () => {
    await say("Ada here.", "+15550001");
    await say("Bob here.", "+15550002");
    await expect.poll(async () => (await threadsOf()).length, poll).toBe(2);
    const customers = await rpc.representative.customerList();
    const of = (externalId: string) =>
      customers.find((each) => each.identities.some((i) => i.externalId === externalId))!;
    const [ada, bob] = [of("+15550001"), of("+15550002")];
    const bobs = (await threadsOf()).find((thread) => thread.customer.id === bob!.id)!;
    return { ada: ada!, bob: bob!, bobsThreadId: bobs.id };
  };
  return {
    deps,
    rpc,
    id,
    say,
    passTime,
    settle,
    threadRows,
    messageRows,
    summaryRows,
    threadsOf,
    closedThread,
    twoCustomers,
  };
}

describe("a closed thread's expiry", () => {
  it("deletes the row, messages and summary 12 months after the close", async () => {
    const { closedThread, passTime, settle, threadRows, messageRows, summaryRows } =
      await instance();
    const threadId = await closedThread();
    expect(await messageRows(threadId)).not.toHaveLength(0);

    passTime(threadExpiryMs);
    await settle();

    expect(await threadRows(threadId)).toEqual([]);
    expect(await messageRows(threadId)).toEqual([]);
    expect(await summaryRows(threadId)).toEqual([]);
  });

  it("keeps a thread closed just under 12 months ago", async () => {
    const { closedThread, passTime, settle, threadRows, messageRows, summaryRows } =
      await instance();
    const threadId = await closedThread();

    passTime(threadExpiryMs - 2 * day);
    await settle();

    expect(await threadRows(threadId)).toHaveLength(1);
    expect(await messageRows(threadId)).not.toHaveLength(0);
    expect(await summaryRows(threadId)).toHaveLength(1);

    passTime(3 * day);
    await settle();
    expect(await threadRows(threadId)).toEqual([]);
  });

  it("expires the thread a merge closes", async () => {
    const { rpc, twoCustomers, passTime, settle, threadRows } = await instance();
    const { ada, bob, bobsThreadId } = await twoCustomers();
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await settle();

    passTime(threadExpiryMs);
    await settle();

    expect(await threadRows(bobsThreadId)).toEqual([]);
  });

  it("expires a held thread a merge closes", async () => {
    const { rpc, twoCustomers, passTime, settle, threadRows } = await instance();
    const { ada, bob, bobsThreadId } = await twoCustomers();
    await rpc.representative.threadTakeOver({ id: bobsThreadId });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await settle();

    passTime(threadExpiryMs);
    await settle();

    expect(await threadRows(bobsThreadId)).toEqual([]);
  });

  it("expires a thread an undone merge closes for holding two people's words", async () => {
    const { rpc, id, say, threadsOf, passTime, settle, threadRows } = await instance();
    await say("Bob here.", "+15550002");
    await say("Ada before.", "+15550001");
    await expect.poll(async () => (await threadsOf()).length, poll).toBe(2);
    const customers = await rpc.representative.customerList();
    const of = (externalId: string) =>
      customers.find((each) => each.identities.some((i) => i.externalId === externalId))!;
    const [ada, bob] = [of("+15550001"), of("+15550002")];
    const adas = (await threadsOf()).find((thread) => thread.customer.id === ada.id)!;
    await rpc.representative.threadTakeOver({ id: adas.id });
    await rpc.representative.customerMerge({ id: ada.id, intoId: bob.id });
    await say("Ada in the merge.", "+15550001");
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    const closed = (await rpc.representative.threadList({ id })).filter(
      (thread) => thread.holder === "closed",
    );
    expect(closed).not.toHaveLength(0);
    await settle();

    passTime(threadExpiryMs);
    await settle();

    for (const thread of closed) expect(await threadRows(thread.id)).toEqual([]);
  });

  it("keeps one expiry per thread, from its latest close", async () => {
    const { deps, closedThread, passTime, settle, threadRows } = await instance();
    const threadId = await closedThread();
    const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
    // The thread was reopened (a merge undone) and closed again 100 days on.
    const again = new Date(Date.now() + 100 * day);
    await feature.context.db.transaction((tx) =>
      queueThreadExpiry(feature.context, tx, threadId, again),
    );

    const queued = await getTestDb()
      .select({ runAfter: job.runAfter })
      .from(job)
      .where(and(eq(job.name, threadExpiryJobName), eq(job.status, "queued")));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAfter.getTime()).toBe(again.getTime() + threadExpiryMs);
    passTime(threadExpiryMs);
    await settle();
    expect(await threadRows(threadId)).toHaveLength(1);
  });

  it("does nothing, and doesn't fail, when its thread is already gone", async () => {
    const { closedThread, passTime, settle, threadRows } = await instance();
    const threadId = await closedThread();
    await getTestDb().delete(representativeThread).where(eq(representativeThread.id, threadId));

    passTime(threadExpiryMs);
    await settle();

    expect(await threadRows(threadId)).toEqual([]);
    const jobs = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(eq(job.name, threadExpiryJobName));
    expect(jobs).not.toHaveLength(0);
    expect(jobs.every((each) => each.status === "succeeded")).toBe(true);
  });

  it("leaves the Customer's profile, and the owner's views, correct", async () => {
    const { rpc, closedThread, passTime, settle, threadsOf } = await instance();
    const threadId = await closedThread();
    const [customer] = await rpc.representative.customerList();
    await rpc.representative.customerProfileSet({
      id: customer!.id,
      field: "language",
      value: "French",
    });
    const before = await rpc.representative.customerList();
    expect(before[0]!.profile).toMatchObject([{ value: "French" }]);

    passTime(threadExpiryMs);
    await settle();

    expect(await rpc.representative.customerList()).toEqual(before);
    expect(await threadsOf()).toEqual([]);
    expect(await rpc.representative.customerSummaryList({ id: customer!.id })).toEqual([]);
    await expect(rpc.representative.threadGet({ id: threadId })).rejects.toThrow();
  });

  it("leaves a hand-off naming its Customer after its thread expires", async () => {
    const { rpc, closedThread, passTime, settle } = await instance({
      turnRounds: [handsOff, () => round()],
    });
    const threadId = await closedThread("I want a refund");
    const [customer] = await rpc.representative.customerList();
    const handOffs = () =>
      getTestDb()
        .select({
          threadId: representativeHandOff.threadId,
          customerId: representativeHandOff.customerId,
        })
        .from(representativeHandOff);
    expect(await handOffs()).toEqual([{ threadId, customerId: customer!.id }]);

    passTime(threadExpiryMs);
    await settle();

    expect(await handOffs()).toEqual([{ threadId: null, customerId: customer!.id }]);
  });
});
