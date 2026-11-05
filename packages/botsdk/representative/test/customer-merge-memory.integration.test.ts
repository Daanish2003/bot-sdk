import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { Transaction } from "@botsdk/bot/plugin";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  answers,
  answersOnce,
  fakeChannel,
  testCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { representative } from "../src";
import type { FixedProfileField, ProfileStatus } from "../src/shared/contract";
import {
  representativeCustomerSummary,
  representativeHandOff,
  representativeProfileValue,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { holdCustomers } from "../src/server/customer-merge";
import { setOwnerValue } from "../src/server/customer-profile";
import { customerSummaryMarker, profileOperationsMarker } from "../src/server/customer-summary";
import { threadExpiryMs } from "../src/server/expiry";
import { threadIdleMs } from "../src/server/idle";

/*
 * Merging two Customers combines their memory, and undoing it puts it back (ticket #1286): a real
 * runner on a fake clock over real Postgres, with a fake Model, read through the owner's API.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;
const ada = "+15550001";
const bob = "+15550002";
const cat = "+15550003";
const dan = "+15550004";

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const isPassCall = (options: TextOptions) =>
  JSON.stringify(options.systemPrompts ?? []).includes(customerSummaryMarker);

type Operation = { field: string; value: string; line: number };

const passReply = (operations: Operation[]) =>
  round(text(`A summary.\n${profileOperationsMarker}\n${JSON.stringify(operations)}`));

const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );

const ago = (days: number) => new Date(Date.now() - days * day);

/** A transaction left open after `work` until `release`, and whether anyone waits on it. */
async function inFlight(work: (tx: Transaction) => Promise<void>) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let pid: number | undefined;
  let ready = () => {};
  const started = new Promise<void>((resolve) => (ready = resolve));
  const done = getTestDb().transaction(async (tx) => {
    await work(tx);
    const pids = await tx.execute(sql`select pg_backend_pid() as pid`);
    pid = (pids.rows[0] as { pid: number }).pid;
    ready();
    await released;
  });
  await started;
  return {
    done,
    release,
    isWaitedOn: async () => {
      const blocked = await getTestDb().execute(
        sql`select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`,
      );
      return blocked.rows.length > 0;
    },
  };
}

async function instance() {
  const pass: Operation[][] = [];
  /** Runs as the pass calls its Model, when it holds nothing. */
  const onPassCall: { current?: () => Promise<void> } = {};
  const turns: Array<() => ReturnType<typeof round>> = [];
  const fake = createFakeAdapter({
    rounds: Array.from({ length: 60 }, () => (options: TextOptions) => {
      if (isPassCall(options)) return passReply(pass.shift() ?? []);
      return turns.shift()?.() ?? answersOnce(options);
    }),
  });
  const gated: AnyTextAdapter = {
    ...(fake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      if (isPassCall(options)) await onPassCall.current?.();
      yield* fake.adapter.chatStream(options);
    },
  };
  const botFake = createFakeAdapter({ rounds: Array.from({ length: 10 }, () => round()) });
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
    adapterFor: (id) => (id === botModel ? botFake.adapter : gated),
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
  /** What a verified sender's Turn was told: the prompt of the Model call it makes. */
  const promptFor = async (externalId: string) => {
    const before = fake.calls.length;
    await testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      message: "What do you know?",
      externalId,
      proof: { rule: "sameIdentity" },
    });
    const call = fake.calls.slice(before).find((each) => !isPassCall(each));
    return JSON.stringify(call?.messages ?? []);
  };
  const say = (message: string, externalId: string) =>
    testCustomerTurn(Object.assign(deps, { timer }), { representativeId: id, message, externalId });
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
  const passTime = async (ms: number) => {
    timer.advance(ms);
    await settle();
  };
  /** A Customer with this identity, who has written once. */
  const customer = async (externalId: string) => {
    await say("Hello", externalId);
    return (await rpc.representative.customerList()).find((each) =>
      each.identities.some((identity) => identity.externalId === externalId),
    )!;
  };
  const seed = (
    customerId: string,
    field: FixedProfileField,
    value: string,
    status: ProfileStatus,
    recordedAt: Date,
  ) =>
    getTestDb().insert(representativeProfileValue).values({
      id: uuidv7(),
      userId: user.id,
      customerId,
      fixedField: field,
      value,
      source: "customer",
      status,
      recordedAt,
    });
  /** The values the owner sees on a Customer, by field. */
  const profile = async (customerId: string) => {
    const found = (await rpc.representative.customerList()).find((each) => each.id === customerId)!;
    return Object.fromEntries(found.profile.map((each) => [each.field, each.value]));
  };
  /** The rows a Customer holds itself, whatever is merged into it. */
  const ownRows = async (customerId: string) => {
    const rows = await getTestDb()
      .select()
      .from(representativeProfileValue)
      .where(eq(representativeProfileValue.customerId, customerId));
    return rows
      .map(({ fixedField, fieldId, value, source, status, recordedAt }) => ({
        field: fixedField ?? fieldId,
        value,
        source,
        status,
        recordedAt,
      }))
      .sort((one, other) => String(one.field).localeCompare(String(other.field)));
  };
  const merge = (absorbed: string, survivor: string) =>
    rpc.representative.customerMerge({ id: absorbed, intoId: survivor });
  const undoLatest = async () => {
    const [latest] = (await rpc.representative.customerMergeList()).filter(
      (each) => each.undoneAt === null,
    );
    return rpc.representative.customerMergeUndo({ id: latest!.id });
  };
  /** The open thread last heard from this address. */
  const openThread = async (externalId: string) => {
    const threads = await rpc.representative.threadList({ id });
    return threads.find(
      (each) => each.lastHeard.externalId === externalId && each.holder !== "closed",
    )!;
  };
  /** Makes a thread's one line a verified Customer's. */
  const verifiedLine = async (threadId: string, saying: string, sender = ada) => {
    await getTestDb()
      .delete(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, threadId));
    await getTestDb().insert(representativeThreadMessage).values({
      id: uuidv7(),
      threadId,
      position: 1,
      author: "customer",
      verified: true,
      channel: fakeChannel,
      externalId: sender,
      text: saying,
    });
  };
  const handOffs = () =>
    getTestDb()
      .select({
        threadId: representativeHandOff.threadId,
        customerId: representativeHandOff.customerId,
      })
      .from(representativeHandOff);
  return {
    id,
    user,
    deps,
    rpc,
    timer,
    onPassCall,
    promptFor,
    pass,
    turns,
    say,
    settle,
    passTime,
    customer,
    seed,
    profile,
    ownRows,
    merge,
    undoLatest,
    openThread,
    verifiedLine,
    handOffs,
  };
}

describe("a survivor's profile after a merge", () => {
  it("is the union of both, confirmed beating claimed, then the newest", async () => {
    const { customer, seed, merge, profile } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    // Only one has it.
    await seed(first.id, "preferred_channel", "sms", "claimed", ago(9));
    await seed(second.id, "address", "1 High St", "claimed", ago(9));
    // The older confirmed beats the newer claimed.
    await seed(first.id, "name", "Claimed newest", "claimed", ago(1));
    await seed(second.id, "name", "Confirmed older", "confirmed", ago(5));
    // Both confirmed: the newest, here the absorbed one's.
    await seed(first.id, "language", "French", "confirmed", ago(5));
    await seed(second.id, "language", "German", "confirmed", ago(1));

    const merged = await merge(second.id, first.id);

    expect(merged.name).toBe("Confirmed older");
    expect(await profile(first.id)).toEqual({
      preferred_channel: "sms",
      address: "1 High St",
      name: "Confirmed older",
      language: "German",
    });
  });

  it("names the survivor on its threads by the union, and each Customer by its own in the merge list", async () => {
    const { id, rpc, customer, seed, merge } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(second.id, "name", "Bob", "confirmed", ago(1));

    await merge(second.id, first.id);

    const threads = await rpc.representative.threadList({ id });
    expect(threads.map((each) => each.customer.name)).toEqual(["Bob", "Bob"]);
    const thread = await rpc.representative.threadGet({ id: threads[0]!.id });
    expect(thread.customer.name).toBe("Bob");
    const [listed] = await rpc.representative.customerMergeList();
    expect(listed).toMatchObject({
      survivor: { id: first.id, name: null },
      absorbed: { id: second.id, name: "Bob" },
    });
  });

  it("reads through a chain of merges, and a chain's undo gives back one link", async () => {
    const { customer, seed, merge, profile, undoLatest } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    const third = await customer(cat);
    await seed(first.id, "name", "Ada", "confirmed", ago(3));
    await seed(second.id, "language", "German", "confirmed", ago(3));

    await merge(first.id, second.id);
    await merge(second.id, third.id);
    expect(await profile(third.id)).toEqual({ name: "Ada", language: "German" });

    await undoLatest();
    expect(await profile(third.id)).toEqual({});
    expect(await profile(second.id)).toEqual({ name: "Ada", language: "German" });
  });
});

describe("undoing a merge", () => {
  it("restores each Customer's own values exactly", async () => {
    const { customer, seed, merge, undoLatest, ownRows, profile } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(first.id, "name", "Ada", "claimed", ago(2));
    await seed(second.id, "name", "Bob", "confirmed", ago(4));
    const before = [await ownRows(first.id), await ownRows(second.id)];

    await merge(second.id, first.id);
    expect(await profile(first.id)).toEqual({ name: "Bob" });
    await undoLatest();

    expect([await ownRows(first.id), await ownRows(second.id)]).toEqual(before);
    expect(await profile(first.id)).toEqual({ name: "Ada" });
    expect(await profile(second.id)).toEqual({ name: "Bob" });
  });

  it("keeps an owner's correction made during the merge with the survivor", async () => {
    const { rpc, customer, seed, merge, undoLatest, profile } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(second.id, "name", "Bob", "confirmed", ago(4));
    await merge(second.id, first.id);

    await rpc.representative.customerRename({ id: first.id, name: "Robert" });
    expect(await profile(first.id)).toEqual({ name: "Robert" });

    await undoLatest();
    expect(await profile(first.id)).toEqual({ name: "Robert" });
    expect(await profile(second.id)).toEqual({ name: "Bob" });
  });
});

describe("an owner clearing a value during a merge", () => {
  it("stays cleared on the survivor, and is back only on the absorbed Customer after undo", async () => {
    const { rpc, customer, seed, merge, undoLatest, profile } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(first.id, "address", "1 High St", "confirmed", ago(5));
    await seed(second.id, "address", "2 Low St", "confirmed", ago(4));
    await merge(second.id, first.id);

    const cleared = await rpc.representative.customerProfileSet({
      id: first.id,
      field: "address",
      value: "",
    });

    expect(cleared.profile).toEqual([]);
    await undoLatest();
    expect(await profile(first.id)).toEqual({});
    expect(await profile(second.id)).toEqual({ address: "2 Low St" });
  });

  it("leaves no trace in the owner's export or the merge list's name", async () => {
    const { deps, user, rpc, customer, seed, merge } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(first.id, "name", "Ada", "confirmed", ago(5));
    await merge(second.id, first.id);

    await rpc.representative.customerRename({ id: first.id, name: "" });

    const [listed] = await rpc.representative.customerMergeList();
    expect(listed!.survivor.name).toBeNull();
    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { customers: Array<{ id: string; name: string | null; profile: unknown[] }> };
    };
    const survivor = exported.representative.customers.find((each) => each.id === first.id);
    expect(survivor).toMatchObject({ name: null, profile: [] });
  });

  it("lets a later pass learn the value again", async () => {
    const {
      rpc,
      pass,
      passTime,
      settle,
      customer,
      seed,
      merge,
      profile,
      openThread,
      verifiedLine,
    } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(second.id, "address", "2 Low St", "confirmed", ago(4));
    await merge(second.id, first.id);
    await settle();
    await rpc.representative.customerProfileSet({ id: first.id, field: "address", value: "" });
    expect(await profile(first.id)).toEqual({});

    const open = await openThread(ada);
    await verifiedLine(open.id, "I moved to 3 Mid St");
    pass.push([{ field: "address", value: "3 Mid St", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({ address: "3 Mid St" });
  });

  it("keeps what it cleared hidden when a later pass only claims the field", async () => {
    const { rpc, pass, passTime, settle, customer, seed, merge, profile, openThread } =
      await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(second.id, "address", "2 Low St", "confirmed", ago(4));
    await merge(second.id, first.id);
    await settle();
    await rpc.representative.customerProfileSet({ id: first.id, field: "address", value: "" });

    const open = await openThread(ada);
    await getTestDb()
      .update(representativeThreadMessage)
      .set({ text: "It is 3 Mid St", verified: false })
      .where(eq(representativeThreadMessage.threadId, open.id));
    pass.push([{ field: "address", value: "3 Mid St", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({});
  });

  it("stays hidden when a pass only claims it for the absorbed Customer, who has the claim after undo", async () => {
    const world = await instance();
    const { rpc, pass, passTime, settle, customer, say, merge, undoLatest, profile, id } = world;
    const first = await customer(ada);
    const second = await customer(bob);
    await merge(second.id, first.id);
    await settle();
    await rpc.representative.customerProfileSet({ id: first.id, field: "address", value: "" });

    await say("It is 2 Low St", bob);
    const open = (await rpc.representative.threadList({ id })).find(
      (each) => each.holder !== "closed",
    )!;
    await world.verifiedLine(open.id, "It is 2 Low St", bob);
    await getTestDb()
      .update(representativeThreadMessage)
      .set({ verified: false })
      .where(eq(representativeThreadMessage.threadId, open.id));
    pass.push([{ field: "address", value: "2 Low St", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({});
    await undoLatest();
    expect(await profile(second.id)).toEqual({ address: "2 Low St" });
  });

  it("hides only what it could see: not its survivor's own, nor a later merge's", async () => {
    const { rpc, customer, seed, merge, profile, passTime } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    const third = await customer(cat);
    const fourth = await customer(dan);
    await seed(first.id, "address", "1 High St", "confirmed", ago(5));
    await seed(third.id, "address", "3 Mid St", "claimed", ago(9));
    await seed(fourth.id, "language", "Welsh", "claimed", ago(9));
    await merge(first.id, second.id);
    await rpc.representative.customerProfileSet({ id: second.id, field: "address", value: "" });
    await rpc.representative.customerProfileSet({ id: second.id, field: "language", value: "" });
    await passTime(60_000);

    await merge(fourth.id, second.id);
    expect(await profile(second.id)).toEqual({ language: "Welsh" });

    await merge(second.id, third.id);
    expect(await profile(third.id)).toEqual({ address: "3 Mid St", language: "Welsh" });
  });
});

describe("a survivor's summaries after a merge", () => {
  it("are chosen newest first across both Customers' threads, and go back on undo", async () => {
    const { id, user, rpc, customer, merge, undoLatest } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    const insertSummary = async (customerId: string, summary: string, createdAt: Date) => {
      const threadId = uuidv7();
      await getTestDb().insert(representativeThread).values({
        id: threadId,
        customerId,
        representativeId: id,
        state: "closed",
        lastChannel: "test",
        lastExternalId: ada,
        messageCount: 0,
      });
      await getTestDb()
        .insert(representativeCustomerSummary)
        .values({ id: uuidv7(), threadId, userId: user.id, text: summary, createdAt });
    };
    await insertSummary(first.id, "oldest", ago(9));
    await insertSummary(second.id, "middle", ago(5));
    await insertSummary(first.id, "newest", ago(1));
    const texts = async (customerId: string) =>
      (await rpc.representative.customerSummaryList({ id: customerId }))
        .map((each) => each.text)
        .filter((each) => each !== "A summary.");

    await merge(second.id, first.id);
    expect(await texts(first.id)).toEqual(["newest", "middle", "oldest"]);

    await undoLatest();
    expect(await texts(first.id)).toEqual(["newest", "oldest"]);
    expect(await texts(second.id)).toEqual(["middle"]);
  });
});

const summarised = async (
  world: Awaited<ReturnType<typeof instance>>,
  customerId: string,
  summary: string,
  createdAt: Date,
  sender?: string,
) => {
  const threadId = uuidv7();
  await getTestDb().insert(representativeThread).values({
    id: threadId,
    customerId,
    representativeId: world.id,
    state: "closed",
    lastChannel: fakeChannel,
    lastExternalId: ada,
    messageCount: 0,
  });
  if (sender) {
    await getTestDb().insert(representativeThreadMessage).values({
      id: uuidv7(),
      threadId,
      position: 1,
      author: "customer",
      verified: true,
      channel: fakeChannel,
      externalId: sender,
      text: "Words",
    });
  }
  await getTestDb()
    .insert(representativeCustomerSummary)
    .values({ id: uuidv7(), threadId, userId: world.user.id, text: summary, createdAt });
  return threadId;
};

describe("a survivor's Turn after a merge", () => {
  it("reads the combined profile, with nothing of what the owner cleared, and each its own after undo", async () => {
    const { rpc, customer, seed, merge, undoLatest, promptFor } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await seed(first.id, "name", "Claimed Ada", "claimed", ago(1));
    await seed(second.id, "name", "Confirmed Bob", "confirmed", ago(5));
    await seed(second.id, "address", "2 Low St", "confirmed", ago(5));
    await seed(second.id, "language", "German", "confirmed", ago(5));
    await merge(second.id, first.id);
    await rpc.representative.customerProfileSet({ id: first.id, field: "language", value: "" });

    const merged = await promptFor(ada);
    expect(merged).toContain("Confirmed Bob");
    expect(merged).toContain("2 Low St");
    expect(merged).not.toContain("Claimed Ada");
    expect(merged).not.toContain("German");
    expect(merged).not.toContain(String.raw`language: \\\"\\\"`);

    await undoLatest();
    const adaAlone = await promptFor(ada);
    expect(adaAlone).toContain("Claimed Ada");
    expect(adaAlone).not.toContain("Confirmed Bob");
    expect(adaAlone).not.toContain("2 Low St");
    const bobAlone = await promptFor(bob);
    expect(bobAlone).toContain("Confirmed Bob");
    expect(bobAlone).toContain("German");
    expect(bobAlone).not.toContain("Claimed Ada");
  });

  it("reads the 5 newest summaries across both Customers' threads, and each its own after undo", async () => {
    const world = await instance();
    const first = await world.customer(ada);
    const second = await world.customer(bob);
    await summarised(world, first.id, "memo-a1", ago(1), ada);
    await summarised(world, second.id, "memo-b2", ago(2), bob);
    await summarised(world, first.id, "memo-a3", ago(3), ada);
    await summarised(world, second.id, "memo-b4", ago(4), bob);
    await summarised(world, first.id, "memo-a5", ago(5), ada);
    await summarised(world, second.id, "memo-b6", ago(6), bob);
    await world.merge(second.id, first.id);
    // The thread the merge closed has its own summary by now, the newest of all.
    await world.settle();

    const merged = await world.promptFor(ada);
    for (const memo of ["memo-a1", "memo-b2", "memo-a3", "memo-b4"]) {
      expect(merged).toContain(memo);
    }
    expect(merged).not.toContain("memo-a5");
    expect(merged).not.toContain("memo-b6");

    await world.undoLatest();
    const adaAlone = await world.promptFor(ada);
    expect(adaAlone).toContain("memo-a1");
    expect(adaAlone).toContain("memo-a5");
    expect(adaAlone).not.toContain("memo-b2");
    const bobAlone = await world.promptFor(bob);
    expect(bobAlone).toContain("memo-b2");
    expect(bobAlone).toContain("memo-b6");
    expect(bobAlone).not.toContain("memo-a1");
  });

  it("counts a thread both spoke on while the merge stands, and leaves it out after undo", async () => {
    const world = await instance();
    const first = await world.customer(ada);
    const second = await world.customer(bob);
    await summarised(world, first.id, "memo-both", ago(1), bob);
    expect(await world.promptFor(ada)).not.toContain("memo-both");

    await world.merge(second.id, first.id);
    expect(await world.promptFor(ada)).toContain("memo-both");

    await world.undoLatest();
    expect(await world.promptFor(ada)).not.toContain("memo-both");
    expect(await world.promptFor(bob)).not.toContain("memo-both");
    const summaries = await world.rpc.representative.customerSummaryList({ id: first.id });
    expect(summaries.map((each) => each.text)).toContain("memo-both");
  });
});

describe("a summary whose thread is at an address the Customer no longer has", () => {
  const corrected = "+15550077";

  const correct = async (
    world: Awaited<ReturnType<typeof instance>>,
    customerId: string,
    from: string,
    to: string,
  ) => {
    const found = (await world.rpc.representative.customerList()).find(
      (each) => each.id === customerId,
    )!;
    await world.rpc.representative.customerUpdateIdentity({
      id: customerId,
      identityId: found.identities.find((each) => each.externalId === from)!.id,
      channel: fakeChannel,
      externalId: to,
    });
  };

  it("still reaches a Turn after the owner corrects that address", async () => {
    const world = await instance();
    const first = await world.customer(ada);
    await summarised(world, first.id, "memo-before-the-typo", ago(1), ada);

    await correct(world, first.id, ada, corrected);

    expect(await world.promptFor(corrected)).toContain("memo-before-the-typo");
  });

  it("stays out once another Customer has that address", async () => {
    const world = await instance();
    const first = await world.customer(ada);
    const second = await world.customer(bob);
    await summarised(world, first.id, "memo-before-the-typo", ago(1), ada);

    await correct(world, first.id, ada, corrected);
    await world.rpc.representative.customerAddIdentity({
      id: second.id,
      channel: fakeChannel,
      externalId: ada,
    });

    expect(await world.promptFor(corrected)).not.toContain("memo-before-the-typo");
  });

  /** The summary of a thread the absorbed Bob alone spoke on, begun while the merge stood. */
  async function onlyBobSpokeDuringMerge(world: Awaited<ReturnType<typeof instance>>) {
    const first = await world.customer(ada);
    const second = await world.customer(bob);
    await world.passTime(threadIdleMs);
    await world.merge(second.id, first.id);
    await world.say("Bob here", bob);
    const open = await world.openThread(bob);
    await world.passTime(threadIdleMs);
    await getTestDb()
      .update(representativeCustomerSummary)
      .set({ text: "memo-bob-alone" })
      .where(eq(representativeCustomerSummary.threadId, open.id));
    expect(await world.promptFor(ada)).toContain("memo-bob-alone");
    await world.undoLatest();
    return { first, second };
  }

  it("stays out after an undo, when only the other person spoke on it", async () => {
    const world = await instance();
    await onlyBobSpokeDuringMerge(world);

    expect(await world.promptFor(ada)).not.toContain("memo-bob-alone");
  });

  it("stays out after an undo even once the other person's address is corrected", async () => {
    const world = await instance();
    const { second } = await onlyBobSpokeDuringMerge(world);

    await correct(world, second.id, bob, corrected);

    expect(await world.promptFor(ada)).not.toContain("memo-bob-alone");
  });

  it("stays out after that Customer is merged into a third", async () => {
    const world = await instance();
    const { first, second } = await onlyBobSpokeDuringMerge(world);
    await correct(world, second.id, bob, corrected);
    const third = await world.customer("+15550066");

    await world.merge(first.id, third.id);

    expect(await world.promptFor(ada)).not.toContain("memo-bob-alone");
  });

  it("stays out for both people's words, once the other person's address is corrected", async () => {
    const world = await instance();
    const first = await world.customer(ada);
    const second = await world.customer(bob);
    const mixed = await summarised(world, first.id, "memo-both", ago(1), ada);
    await getTestDb().insert(representativeThreadMessage).values({
      id: uuidv7(),
      threadId: mixed,
      position: 2,
      author: "customer",
      channel: fakeChannel,
      externalId: bob,
      text: "Bob's words",
    });
    await world.merge(second.id, first.id);
    await world.undoLatest();

    await correct(world, second.id, bob, corrected);

    expect(await world.promptFor(ada)).not.toContain("memo-both");
  });
});

describe("a hand-off's Customer", () => {
  it("moves on merge and back on undo", async () => {
    const { turns, customer, merge, undoLatest, handOffs } = await instance();
    const first = await customer(ada);
    turns.push(handsOff);
    const second = await customer(bob);
    expect((await handOffs())[0]!.customerId).toBe(second.id);

    await merge(second.id, first.id);
    expect((await handOffs())[0]!.customerId).toBe(first.id);

    await undoLatest();
    expect((await handOffs())[0]!.customerId).toBe(second.id);
  });

  it("goes back from a moved thread that handed off during the merge", async () => {
    const { turns, say, customer, merge, undoLatest, handOffs, passTime } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    // Both threads go idle, then Bob's alone opens again: it moves still open.
    await passTime(threadIdleMs);
    await say("Back again", bob);
    await merge(second.id, first.id);

    turns.push(handsOff);
    await say("I want a refund", bob);
    expect((await handOffs())[0]!.customerId).toBe(first.id);

    await undoLatest();
    expect((await handOffs())[0]!.customerId).toBe(second.id);
  });

  it("goes back from a moved thread that handed off during the merge, after the thread expired", async () => {
    const { turns, say, customer, merge, undoLatest, handOffs, passTime } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await passTime(threadIdleMs);
    await say("Back again", bob);
    await merge(second.id, first.id);
    turns.push(handsOff, answers);
    await say("I want a refund", bob);

    // The hand-off's overdue note comes due on time, before the idle days.
    await passTime(31 * 60_000);
    await passTime(threadIdleMs + 60_000);
    await passTime(threadExpiryMs);
    expect(await handOffs()).toEqual([{ threadId: null, customerId: first.id }]);

    await undoLatest();
    expect(await handOffs()).toEqual([{ threadId: null, customerId: second.id }]);
  });

  it("stays on the survivor from a thread begun since the merge", async () => {
    const { turns, customer, say, merge, undoLatest, handOffs, passTime } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await passTime(threadIdleMs);
    await merge(second.id, first.id);

    turns.push(handsOff);
    await say("I want a refund", ada);
    expect((await handOffs())[0]!.customerId).toBe(first.id);

    await undoLatest();
    expect((await handOffs())[0]!.customerId).toBe(first.id);
  });

  it("goes back even when its thread has expired since", async () => {
    const { turns, customer, merge, undoLatest, passTime, handOffs } = await instance();
    const first = await customer(ada);
    turns.push(handsOff);
    const second = await customer(bob);
    await merge(second.id, first.id);
    await passTime(threadExpiryMs);
    expect(await handOffs()).toEqual([{ threadId: null, customerId: first.id }]);

    await undoLatest();

    expect(await handOffs()).toEqual([{ threadId: null, customerId: second.id }]);
  });
});

describe("the pass on a thread that moved in a merge", () => {
  it("writes to the Customer the thread came from, so undoing leaves the survivor without it", async () => {
    const {
      pass,
      customer,
      merge,
      undoLatest,
      settle,
      openThread,
      verifiedLine,
      profile,
      ownRows,
    } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    const absorbed = await openThread(bob);
    await verifiedLine(absorbed.id, "My address is 2 Low St", bob);
    pass.push([{ field: "address", value: "2 Low St", line: 1 }]);

    // Both have an open thread, so this closes the absorbed one, and its pass runs on the merged Customer.
    await merge(second.id, first.id);
    await settle();

    expect(await profile(first.id)).toEqual({ address: "2 Low St" });
    expect(await ownRows(first.id)).toEqual([]);
    await undoLatest();
    expect(await profile(first.id)).toEqual({});
    expect(await profile(second.id)).toEqual({ address: "2 Low St" });
  });

  it("goes back through a chain to the first Customer", async () => {
    const {
      pass,
      say,
      customer,
      merge,
      passTime,
      settle,
      openThread,
      verifiedLine,
      ownRows,
      profile,
    } = await instance();
    const second = await customer(bob);
    await passTime(threadIdleMs);
    const first = await customer(ada);
    const third = await customer(cat);
    const moved = await openThread(ada);
    await say("Hello", ada);
    await verifiedLine(moved.id, "My address is 1 High St");
    pass.push([{ field: "address", value: "1 High St", line: 1 }]);

    // Bob has no open thread, so Ada's moves still open; Cat has one, so that second merge closes it.
    await merge(first.id, second.id);
    await merge(second.id, third.id);
    await settle();

    expect((await ownRows(first.id)).map((row) => row.value)).toEqual(["1 High St"]);
    expect(await ownRows(third.id)).toEqual([]);
    expect(await profile(third.id)).toEqual({ address: "1 High St" });
  });

  it("writes a value to the Customer whose words it cites, on a thread both spoke on", async () => {
    const { id, rpc, pass, customer, say, merge, undoLatest, passTime, verifiedLine, profile } =
      await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await merge(second.id, first.id);
    await say("Bob here again", bob);
    const open = (await rpc.representative.threadList({ id })).find(
      (each) => each.holder !== "closed",
    )!;
    await verifiedLine(open.id, "My address is 2 Low St", bob);
    pass.push([{ field: "address", value: "2 Low St", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({ address: "2 Low St" });
    await undoLatest();
    expect(await profile(first.id)).toEqual({});
    expect(await profile(second.id)).toEqual({ address: "2 Low St" });
  });

  it("lets a verified line write over a claimed value that an owner's line gave", async () => {
    const { pass, customer, say, passTime, openThread, profile, id, rpc } = await instance();
    const first = await customer(ada);
    const open = await openThread(ada);
    await rpc.representative.threadTakeOver({ id: open.id });
    await rpc.representative.threadSend({ id: open.id, text: "Their address is 1 High St" });
    await rpc.representative.threadHandBack({ id: open.id });
    const lines = await getTestDb()
      .select({
        position: representativeThreadMessage.position,
        author: representativeThreadMessage.author,
      })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, open.id));
    const ownerLine = lines.find((line) => line.author === "owner")!.position;
    pass.push([{ field: "address", value: "1 High St", line: ownerLine }]);
    await passTime(threadIdleMs);
    expect(await profile(first.id)).toEqual({ address: "1 High St" });

    await say("Hello", ada);
    const next = (await rpc.representative.threadList({ id })).find(
      (each) => each.holder !== "closed",
    )!;
    await getTestDb()
      .update(representativeThreadMessage)
      .set({ text: "I moved to 2 Low St", verified: true })
      .where(eq(representativeThreadMessage.threadId, next.id));
    pass.push([{ field: "address", value: "2 Low St", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({ address: "2 Low St" });
  });

  it("doesn't beat a value the owner set on either Customer", async () => {
    const {
      rpc,
      pass,
      customer,
      merge,
      passTime,
      settle,
      openThread,
      verifiedLine,
      profile,
      ownRows,
    } = await instance();
    const first = await customer(ada);
    const second = await customer(bob);
    await rpc.representative.customerRename({ id: second.id, name: "Bob" });
    await merge(second.id, first.id);
    await settle();

    const open = await openThread(ada);
    await verifiedLine(open.id, "I am Eve");
    pass.push([{ field: "name", value: "Eve", line: 1 }]);
    await passTime(threadIdleMs);

    expect(await profile(first.id)).toEqual({ name: "Bob" });
    expect(await ownRows(first.id)).toEqual([]);
  });
});

describe("the pass against a write still in flight", () => {
  /** Holds `work` open across the pass's write, and returns once the pass has written. */
  async function duringPass(
    { onPassCall, timer, settle }: Awaited<ReturnType<typeof instance>>,
    work: (tx: Transaction) => Promise<void>,
    close: () => void | Promise<unknown>,
  ) {
    let open: Awaited<ReturnType<typeof inFlight>> | undefined;
    onPassCall.current = async () => {
      open = await inFlight(work);
    };
    await close();
    try {
      await vi.waitFor(
        async () => {
          timer.tick();
          expect(await open?.isWaitedOn()).toBe(true);
        },
        { timeout: 10_000 },
      );
    } finally {
      open?.release();
      await open?.done;
    }
    await settle();
  }

  it("leaves a value the owner is setting on that Customer", async () => {
    const context = await instance();
    const { user, pass, customer, openThread, verifiedLine, ownRows, timer } = context;
    const first = await customer(ada);
    const open = await openThread(ada);
    await verifiedLine(open.id, "My address is 9 Fake St");
    pass.push([{ field: "address", value: "9 Fake St", line: 1 }]);

    await duringPass(
      context,
      async (tx) => {
        await holdCustomers(tx, [first.id]);
        await setOwnerValue(tx, timer.clock.now(), user.id, first.id, "address", "1 High St");
      },
      () => timer.advance(threadIdleMs),
    );

    expect(await ownRows(first.id)).toMatchObject([
      { field: "address", value: "1 High St", source: "owner", status: "confirmed" },
    ]);
  });

  it("doesn't let a claim beat a confirmed value that another write is making", async () => {
    const context = await instance();
    const { user, pass, customer, openThread, verifiedLine, ownRows, timer } = context;
    const first = await customer(ada);
    const open = await openThread(ada);
    await verifiedLine(open.id, "Send it wherever");
    pass.push([{ field: "address", value: "9 Fake St", line: 1 }]);

    await duringPass(
      context,
      async (tx) => {
        await tx.insert(representativeProfileValue).values({
          id: uuidv7(),
          userId: user.id,
          customerId: first.id,
          fixedField: "address",
          value: "1 High St",
          source: "customer",
          status: "confirmed",
          recordedAt: timer.clock.now(),
        });
      },
      () => timer.advance(threadIdleMs),
    );

    expect(await ownRows(first.id)).toMatchObject([
      { field: "address", value: "1 High St", status: "confirmed" },
    ]);
  });

  it("doesn't beat a value the owner is setting on the survivor, writing to the absorbed Customer", async () => {
    const context = await instance();
    const { user, pass, customer, merge, openThread, verifiedLine, ownRows, profile } = context;
    const first = await customer(ada);
    const second = await customer(bob);
    const absorbed = await openThread(bob);
    await verifiedLine(absorbed.id, "My address is 2 Low St", bob);
    pass.push([{ field: "address", value: "2 Low St", line: 1 }]);

    await duringPass(
      context,
      async (tx) => {
        await holdCustomers(tx, [first.id]);
        // Older than the pass's write, so that write would win the read were it let through.
        await setOwnerValue(tx, ago(1), user.id, first.id, "address", "1 High St");
      },
      () => merge(second.id, first.id),
    );

    expect(await profile(first.id)).toEqual({ address: "1 High St" });
    expect(await ownRows(second.id)).toEqual([]);
  });
});
