import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { botAssignment, channelAccount, job, usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  answers,
  answersOnce,
  fakeChannel,
  testCustomerHeard,
  testCustomerTurn,
  startTestCustomerTurn,
  autoSource,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { representative } from "../src";
import { deleteCustomer } from "../src/server/customer-delete";
import { codeHandOffKind, limitNoteKind, type StoredReplyKind } from "../src/shared/replies";
import { afterThreadClose, customerSummaryMarker } from "../src/server/customer-summary";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeCustomerSummary,
  representativeFactProposal,
  representativeGap,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeHandOff,
  representativeProfileValue,
  representativeThread,
  representativeThreadMessage,
  representativeVerification,
} from "../src/server/db/schema";
import { deliverHandOffResult } from "../src/server/hand-off-result";
import { threadIdleMs } from "../src/server/idle";

/*
 * Deleting a Customer (ticket #1287, spec #1170): the owner's delete really deletes, the Customers
 * merged into them too. Driven through the owner API with a real runner on a fake clock over real
 * Postgres. The completeness test walks the database's own foreign keys, so a new table linked to a
 * Customer fails it until it is seeded here and goes with the delete.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const poll = { timeout: 10_000 };

const adaNumber = "+15550001";
const bobNumber = "+15550002";
const carolNumber = "+15550003";

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

// A test claims a job by hand: none another test left behind may be claimed first.
beforeEach(async () => {
  await getTestDb()
    .update(job)
    .set({ status: "cancelled" })
    .where(inArray(job.status, ["queued", "running"]));
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

/** One owner's serving Representative. With `started` false, no job runs: what is queued stays queued. */
async function instance({
  turnRounds = [],
  started = true,
  held,
}: {
  turnRounds?: Array<() => ReturnType<typeof round>>;
  started?: boolean;
  held?: Promise<void> | (() => Promise<void> | undefined);
} = {}) {
  const turns = [...turnRounds];
  const fake = createFakeAdapter({
    rounds: Array.from({ length: 40 }, () => (options: TextOptions) => {
      if (isPassCall(options)) return round(text("Asked about hours."));
      return turns.shift()?.() ?? answersOnce(options);
    }),
  });
  const entered: unknown[] = [];
  const gated: AnyTextAdapter = {
    ...(fake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      entered.push(options);
      await (typeof held === "function" ? held() : held);
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
  if (started) await jobs.start();
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
  const say = (message: string, externalId: string) =>
    testCustomerTurn(Object.assign(deps!, { timer }), {
      representativeId: id,
      message,
      externalId,
    });
  /** The Customer is heard, and no Turn is left to answer them. */
  const heard = (message: string, externalId: string) =>
    testCustomerHeard(deps!, { representativeId: id, message, externalId });
  const customerAt = async (externalId: string) => {
    const customers = await rpc.representative.customerList();
    return customers.find((each) => each.identities.some((i) => i.externalId === externalId))!;
  };
  /** Moves the clock, fires the runner's timers, and waits for every job due to end. */
  const settle = async (ms = 1_000) => {
    timer.advance(ms);
    await expect
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
  };
  const context = () =>
    deps!.parts.features.find(({ feature }) => feature.id === "representative")!.context;
  return {
    deps,
    jobs,
    timer,
    entered,
    botId,
    user,
    rpc,
    id,
    say,
    heard,
    customerAt,
    settle,
    context,
  };
}

const tables = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

async function rowsOf<T>(query: ReturnType<typeof sql>) {
  const { rows } = await getTestDb().execute(query);
  return rows as T[];
}

/** Each foreign key in the `botsdk` schema: a column of `child` pointing at `parent`. */
const foreignKeys = () =>
  rowsOf<{ child: string; column: string; parent: string }>(sql`
    select c.conrelid::regclass::text as child, a.attname as column, c.confrelid::regclass::text as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'botsdk'::regnamespace`);

/** The primary key column of `table`. */
async function primaryKeyOf(table: string) {
  const [key] = await rowsOf<{ column: string }>(sql`
    select a.attname as column
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'p' and c.conrelid = ${table}::regclass`);
  return key!.column;
}

/** The ids of every row a foreign key chain ties to these Customers, by table. */
async function rowsLinkedTo(customerIds: string[]) {
  const edges = await foreignKeys();
  const customerTable = (
    await rowsOf<{ name: string }>(
      sql`select 'botsdk.representative_customer'::regclass::text as name`,
    )
  )[0]!.name;
  const reached = new Map<string, Set<string>>([[customerTable, new Set(customerIds)]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { child, column, parent } of edges) {
      const ids = [...(reached.get(parent) ?? [])];
      if (ids.length === 0) continue;
      const key = await primaryKeyOf(child);
      const rows = await rowsOf<{ id: string }>(
        sql`select ${sql.raw(`"${key}"`)}::text as id from ${sql.raw(child)} where ${sql.raw(`"${column}"`)}::text in (${tables(ids)})`,
      );
      const held = reached.get(child) ?? new Set<string>();
      for (const { id } of rows) {
        if (!held.has(id)) {
          held.add(id);
          grew = true;
        }
      }
      if (held.size > 0) reached.set(child, held);
    }
  }
  return { reached, customerTable, edges };
}

const countOf = async (table: string) =>
  Number(
    (await rowsOf<{ n: string }>(sql`select count(*)::text as n from ${sql.raw(table)}`))[0]!.n,
  );

/**
 * An owner with Ada, a Customer who has one of everything, Bob merged into her, and Carol, who has her
 * own thread, value and hand-off and stays. A second owner has a Customer at Ada's own number.
 */
async function seeded() {
  const owner = await instance({ turnRounds: [handsOff, () => round(), () => round(), handsOff] });
  const { rpc, say, customerAt, settle } = owner;
  await say("Ada wants a refund.", adaNumber);
  await say("Bob here.", bobNumber);
  await say("Carol wants a refund.", carolNumber);
  await settle();
  const ada = await customerAt(adaNumber);
  const bob = await customerAt(bobNumber);
  const carol = await customerAt(carolNumber);
  for (const id of [ada.id, carol.id]) {
    await rpc.representative.customerProfileSet({ id, field: "address", value: `${id} street` });
  }
  await rpc.representative.customerProfileSet({ id: bob.id, field: "language", value: "French" });
  const identityOf = async (customerId: string) =>
    (
      await getTestDb()
        .select({ id: representativeCustomerIdentity.id })
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.customerId, customerId))
    )[0]!.id;
  const adaIdentity = await identityOf(ada.id);
  await getTestDb()
    .insert(representativeVerification)
    .values({
      id: crypto.randomUUID(),
      senderIdentityId: adaIdentity,
      targetIdentityId: adaIdentity,
      kind: "code",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
  await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
  await settle();
  const other = await instance();
  await other.say("Someone else's Customer.", adaNumber);
  await other.settle();
  return { ...owner, ada, bob, carol, other };
}

const threadsOfCustomers = (ids: string[]) =>
  getTestDb()
    .select()
    .from(representativeThread)
    .where(inArray(representativeThread.customerId, ids));

const handOffsAt = (externalId: string) =>
  getTestDb()
    .select()
    .from(representativeHandOff)
    .where(eq(representativeHandOff.externalId, externalId));

describe("deleting a Customer", () => {
  it("removes their row, identities, values, summaries, threads, messages and hand-off contact details", async () => {
    const { rpc, ada, bob } = await seeded();
    const [thread] = await threadsOfCustomers([ada.id]);
    const closed = (await threadsOfCustomers([ada.id])).find((row) => row.state === "closed")!;
    expect(
      await getTestDb()
        .select({ id: representativeCustomerSummary.id })
        .from(representativeCustomerSummary)
        .where(eq(representativeCustomerSummary.threadId, closed.id)),
    ).toHaveLength(1);
    expect(await handOffsAt(adaNumber)).not.toHaveLength(0);

    await rpc.representative.customerDelete({ id: ada.id });

    const customers = await getTestDb()
      .select({ id: representativeCustomer.id })
      .from(representativeCustomer)
      .where(inArray(representativeCustomer.id, [ada.id, bob.id]));
    expect(customers).toEqual([]);
    expect(await threadsOfCustomers([ada.id, bob.id])).toEqual([]);
    expect(
      await getTestDb()
        .select({ id: representativeThreadMessage.id })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, thread!.id)),
    ).toEqual([]);
    expect(
      await getTestDb()
        .select({ id: representativeProfileValue.id })
        .from(representativeProfileValue)
        .where(inArray(representativeProfileValue.customerId, [ada.id, bob.id])),
    ).toEqual([]);
    expect(
      await getTestDb()
        .select({ id: representativeCustomerSummary.id })
        .from(representativeCustomerSummary)
        .where(eq(representativeCustomerSummary.threadId, closed.id)),
    ).toEqual([]);
    expect(await handOffsAt(adaNumber)).toEqual([]);
    await expect(rpc.representative.customerSummaryList({ id: ada.id })).rejects.toThrow();
  });

  it("deletes everyone merged in, however many merges away, and the merges", async () => {
    const owner = await instance();
    const { rpc, say, customerAt, settle } = owner;
    await say("One.", "+15551001");
    await say("Two.", "+15551002");
    await say("Three.", "+15551003");
    await settle();
    const [one, two, three] = [
      await customerAt("+15551001"),
      await customerAt("+15551002"),
      await customerAt("+15551003"),
    ];
    await rpc.representative.customerMerge({ id: three.id, intoId: two.id });
    await rpc.representative.customerMerge({ id: two.id, intoId: one.id });

    await rpc.representative.customerDelete({ id: one.id });

    expect(
      await getTestDb()
        .select({ id: representativeCustomer.id })
        .from(representativeCustomer)
        .where(inArray(representativeCustomer.id, [one.id, two.id, three.id])),
    ).toEqual([]);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
  });

  it("leaves a Customer whose merge was undone, and takes any history holding the deleted ids", async () => {
    const owner = await instance();
    const { rpc, say, customerAt, settle } = owner;
    await say("Keeps.", "+15552001");
    await say("Goes.", "+15552002");
    await say("Later.", "+15552003");
    await settle();
    const [keeps, goes, later] = [
      await customerAt("+15552001"),
      await customerAt("+15552002"),
      await customerAt("+15552003"),
    ];
    // Goes passes through Keeps and on to Later, and comes back each time: Later's undone merge
    // holds Goes's ids, though neither of its Customers is Goes.
    await rpc.representative.customerMerge({ id: goes.id, intoId: keeps.id });
    await rpc.representative.customerMerge({ id: keeps.id, intoId: later.id });
    const merges = await rpc.representative.customerMergeList();
    for (const merge of merges) await rpc.representative.customerMergeUndo({ id: merge.id });

    await rpc.representative.customerDelete({ id: goes.id });

    expect((await rpc.representative.customerList()).map((each) => each.id).sort()).toEqual(
      [keeps.id, later.id].sort(),
    );
    expect(await threadsOfCustomers([keeps.id])).toHaveLength(1);
    const left = await getTestDb()
      .select()
      .from(representativeCustomerMerge)
      .where(eq(representativeCustomerMerge.userId, owner.user.id));
    expect(JSON.stringify(left)).not.toContain(goes.id);
    expect(JSON.stringify(left)).not.toContain(goes.identities[0]!.id);
  });

  describe("what an undone merge left of them was owed", () => {
    /** Ada's thread with Bob's words on it, a limit and the owner's list owing them from `waitingFrom`. */
    async function owed(adaIsAnswered: boolean, waitingFrom: number, between?: StoredReplyKind) {
      const answer = () =>
        round(
          toolCall({
            name: "reply",
            input: { text: "Hello.", kind: "small_talk", topic: "general", sources: [autoSource] },
          }),
        );
      const owner = await instance({ turnRounds: [answer, () => round()] });
      const { rpc, say, heard, customerAt, settle } = owner;
      await (adaIsAnswered ? say : heard)("Ada speaks.", adaNumber);
      await heard("Bob speaks.", bobNumber);
      await settle();
      const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
      await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
      await heard("Bob on Ada's thread.", bobNumber);
      await settle();
      const [merge] = await rpc.representative.customerMergeList();
      await rpc.representative.customerMergeUndo({ id: merge!.id });
      await settle(threadIdleMs);
      const shared = (await threadsOfCustomers([ada.id])).find((row) => row.state === "closed")!;
      const noted = new Date();
      if (between) {
        // Code's fixed words between Ada's question and Bob's, in the place they would have had.
        await getTestDb()
          .update(representativeThreadMessage)
          .set({ position: 3 })
          .where(
            and(
              eq(representativeThreadMessage.threadId, shared.id),
              eq(representativeThreadMessage.position, 2),
            ),
          );
        await getTestDb().insert(representativeThreadMessage).values({
          id: uuidv7(),
          threadId: shared.id,
          position: 2,
          author: "representative",
          text: "Fixed words",
          replyKind: between,
          verified: false,
          channel: fakeChannel,
          externalId: adaNumber,
          createdAt: noted,
        });
      }
      await getTestDb()
        .update(representativeThread)
        .set({ waitingFrom, limitNotedAt: noted, leftForOwnerAt: noted })
        .where(eq(representativeThread.id, shared.id));
      await deleteCustomer(owner.context(), owner.user.id, bob.id);
      const [row] = await getTestDb()
        .select()
        .from(representativeThread)
        .where(eq(representativeThread.id, shared.id));
      return row!;
    }

    it("clears what a limit left on the thread, when nothing else is owed", async () => {
      const row = await owed(true, 3);
      expect(row.waitingFrom).toBeNull();
      expect(row.limitNotedAt).toBeNull();
      expect(row.leftForOwnerAt).toBeNull();
    });

    it.each<StoredReplyKind>([limitNoteKind, codeHandOffKind])(
      "keeps what is left for the owner when only a %s came after someone else's question",
      async (kind) => {
        const row = await owed(false, 3, kind);
        expect(row.leftForOwnerAt).not.toBeNull();
      },
    );

    it("keeps both while someone else's words are still owed", async () => {
      const row = await owed(false, 1);
      expect(row.waitingFrom).toBe(1);
      expect(row.limitNotedAt).not.toBeNull();
      expect(row.leftForOwnerAt).not.toBeNull();
    });
  });

  it("removes what an undone merge left of them on another Customer's thread, and nothing of theirs", async () => {
    const owner = await instance({ turnRounds: [handsOff, answers, () => round()] });
    const { rpc, say, heard, customerAt, settle } = owner;
    await heard("Ada speaks.", adaNumber);
    await heard("Bob speaks.", bobNumber);
    await settle();
    const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await say("Bob on Ada's thread.", bobNumber);
    await settle();
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    await settle(threadIdleMs);
    const shared = (await threadsOfCustomers([ada.id])).find((row) => row.state === "closed")!;
    expect(await handOffsAt(bobNumber)).toHaveLength(1);
    // Where a verified sender would have left it, on the account they wrote to.
    const accountId = uuidv7();
    await getTestDb().insert(channelAccount).values({
      id: accountId,
      platform: "sms",
      platformBotId: "1",
      handle: "+1",
      encrypted: "x",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await getTestDb()
      .update(representativeThread)
      .set({ lastExternalId: bobNumber, channelAccountId: accountId })
      .where(eq(representativeThread.id, shared.id));
    const [theirHandOff] = await handOffsAt(bobNumber);

    const { assignmentIds } = await deleteCustomer(owner.context(), owner.user.id, bob.id);

    expect(assignmentIds).toContain(theirHandOff!.assignmentId);
    const left = await getTestDb()
      .select({
        text: representativeThreadMessage.text,
        externalId: representativeThreadMessage.externalId,
      })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, shared.id));
    expect(left.map((row) => row.text)).toEqual(["Ada speaks."]);
    expect(left.map((row) => row.externalId)).toEqual([adaNumber]);
    const [thread] = await getTestDb()
      .select({
        lastExternalId: representativeThread.lastExternalId,
        channelAccountId: representativeThread.channelAccountId,
      })
      .from(representativeThread)
      .where(eq(representativeThread.id, shared.id));
    expect(thread?.lastExternalId).toBe(adaNumber);
    // Bob wrote to it, and Ada may never have.
    expect(thread?.channelAccountId).toBeNull();
    expect(await handOffsAt(bobNumber)).toEqual([]);
    expect(
      await getTestDb()
        .select({ id: representativeCustomerSummary.id })
        .from(representativeCustomerSummary)
        .where(eq(representativeCustomerSummary.threadId, shared.id)),
    ).toEqual([]);
    expect((await rpc.representative.customerList()).map((each) => each.id)).toEqual([ada.id]);
  });

  it("strips what it removed from a merge that still stands, and the merge can still be undone", async () => {
    const zedNumber = "+15550028";
    const owner = await instance({ turnRounds: [handsOff, answers, () => round()] });
    const { rpc, say, heard, customerAt, settle } = owner;
    await heard("Ada speaks.", adaNumber);
    await heard("Bob speaks.", bobNumber);
    await settle();
    const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await say("Bob on Ada's thread.", bobNumber);
    await settle();
    const [first] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: first!.id });
    await say("Zed speaks.", zedNumber);
    await settle();
    const zed = await customerAt(zedNumber);
    await rpc.representative.customerMerge({ id: ada.id, intoId: zed.id });
    const [theirs] = await handOffsAt(bobNumber);
    const standing = () =>
      getTestDb()
        .select()
        .from(representativeCustomerMerge)
        .where(eq(representativeCustomerMerge.absorbedCustomerId, ada.id));
    expect((await standing())[0]!.handOffIds).toContain(theirs!.assignmentId);

    await rpc.representative.customerDelete({ id: bob.id });

    const [merge] = await standing();
    expect(merge!.undoneAt).toBeNull();
    expect(merge!.handOffIds).not.toContain(theirs!.assignmentId);
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    expect((await rpc.representative.customerList()).map((each) => each.id).sort()).toEqual(
      [ada.id, zed.id].sort(),
    );
  });

  it("removes a thread of another Customer's that held only their words", async () => {
    const owner = await instance();
    const { rpc, say, customerAt, settle } = owner;
    await say("Ada speaks.", adaNumber);
    await say("Bob speaks.", bobNumber);
    await settle();
    const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await say("Bob on Ada's thread.", bobNumber);
    await settle();
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    const shared = (await threadsOfCustomers([ada.id])).find((row) => row.state === "closed")!;
    await getTestDb()
      .delete(representativeThreadMessage)
      .where(
        and(
          eq(representativeThreadMessage.threadId, shared.id),
          eq(representativeThreadMessage.externalId, adaNumber),
        ),
      );

    await rpc.representative.customerDelete({ id: bob.id });

    expect(await threadsOfCustomers([ada.id])).toEqual([]);
    expect((await rpc.representative.customerList()).map((each) => each.id)).toEqual([ada.id]);
  });

  const wordsOn = async (customerIds: string[]) => {
    const threads = await threadsOfCustomers(customerIds);
    const rows = await getTestDb()
      .select({ text: representativeThreadMessage.text })
      .from(representativeThreadMessage)
      .where(
        inArray(
          representativeThreadMessage.threadId,
          threads.map((row) => row.id),
        ),
      );
    return rows.map((row) => row.text);
  };

  it("takes a proof's decision at their address from another Customer's thread", async () => {
    const { rpc, ada, carol } = await seeded();
    const [carolThread] = await threadsOfCustomers([carol.id]);
    const atAda = uuidv7();
    await getTestDb().insert(representativeOutboundDecision).values({
      id: atAda,
      threadId: carolThread!.id,
      kind: "proof",
      outcome: "send",
      rule: "passed",
      channel: fakeChannel,
      externalId: adaNumber,
      createdAt: new Date(),
    });

    await rpc.representative.customerDelete({ id: ada.id });

    const left = await getTestDb()
      .select({ id: representativeOutboundDecision.id })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.id, atAda));
    expect(left).toEqual([]);
  });

  it("takes a proof's decision at an address since corrected from another Customer's thread", async () => {
    const { rpc, ada, carol } = await seeded();
    const [carolThread] = await threadsOfCustomers([carol.id]);
    const atAda = uuidv7();
    await getTestDb().insert(representativeOutboundDecision).values({
      id: atAda,
      threadId: carolThread!.id,
      kind: "proof",
      outcome: "send",
      rule: "passed",
      channel: fakeChannel,
      externalId: adaNumber,
      createdAt: new Date(),
    });
    const listed = await rpc.representative.customerList();
    const { identities } = listed.find(({ id }) => id === ada.id)!;
    const identity = identities.find(({ externalId }) => externalId === adaNumber)!;
    await rpc.representative.customerUpdateIdentity({
      id: ada.id,
      identityId: identity.id,
      channel: fakeChannel,
      externalId: "+15550998",
    });

    await rpc.representative.customerDelete({ id: ada.id });

    const left = await getTestDb()
      .select({ id: representativeOutboundDecision.id })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.id, atAda));
    expect(left).toEqual([]);
  });

  it("finds their words on a thread that a later merge moved to someone else", async () => {
    const zedNumber = "+15550026";
    const { rpc, say, customerAt, settle } = await instance();
    await say("Ada speaks.", adaNumber);
    await say("Bob speaks.", bobNumber);
    await say("Zed speaks.", zedNumber);
    await settle();
    const [ada, bob, zed] = [
      await customerAt(adaNumber),
      await customerAt(bobNumber),
      await customerAt(zedNumber),
    ];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await say("Bob on Ada's thread.", bobNumber);
    await settle();
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    await rpc.representative.customerMerge({ id: ada.id, intoId: zed.id });
    await settle();
    expect(await wordsOn([zed.id])).toContain("Bob on Ada's thread.");

    await rpc.representative.customerDelete({ id: bob.id });

    const left = await wordsOn([zed.id]);
    expect(left).not.toContain("Bob on Ada's thread.");
    expect(left).toContain("Ada speaks.");
  });

  it("finds their words on the thread of a Customer they never merged with directly", async () => {
    const laterNumber = "+15550027";
    const { rpc, say, customerAt, settle } = await instance();
    await say("Ada speaks.", adaNumber);
    await say("Bob speaks.", bobNumber);
    await say("Later speaks.", laterNumber);
    await settle();
    const [ada, bob, later] = [
      await customerAt(adaNumber),
      await customerAt(bobNumber),
      await customerAt(laterNumber),
    ];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await rpc.representative.customerMerge({ id: ada.id, intoId: later.id });
    await settle();
    await say("Bob on Later's thread.", bobNumber);
    await settle();
    for (const merge of await rpc.representative.customerMergeList()) {
      await rpc.representative.customerMergeUndo({ id: merge.id });
    }
    await settle();
    expect(await wordsOn([later.id])).toContain("Bob on Later's thread.");

    await rpc.representative.customerDelete({ id: bob.id });

    const left = await wordsOn([later.id]);
    expect(left).not.toContain("Bob on Later's thread.");
    expect(left).toContain("Later speaks.");
  });

  it("cancels a pass queued on another Customer's thread that it took their words from", async () => {
    const owner = await instance({ started: false });
    const { deps, rpc, id, customerAt } = owner;
    const start = (message: string, externalId: string) =>
      startTestCustomerTurn(deps, { representativeId: id, message, externalId });
    await start("Ada.", adaNumber);
    await start("Bob.", bobNumber);
    const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await start("Bob on Ada's thread.", bobNumber);
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    const [shared] = await threadsOfCustomers([ada.id]);
    await owner.context().db.transaction((tx) => afterThreadClose(owner.context(), tx, shared!.id));
    const passStatus = async () =>
      (
        await getTestDb()
          .select({ status: job.status, payload: job.payload })
          .from(job)
          .where(eq(job.name, "representative.customer-summary"))
      )
        .filter((row) => (row.payload as { threadId: string }).threadId === shared!.id)
        .map((row) => row.status);
    expect(await passStatus()).toEqual(["queued"]);

    await rpc.representative.customerDelete({ id: bob.id });

    expect(await passStatus()).toEqual(["cancelled"]);
  });

  describe("what a thread of another Customer's waited on from them", () => {
    const zed = "+15550009";
    const newAddress = "+15550008";

    /** Ada on her open thread, from two addresses, the first answered. */
    async function twoAddresses(owner: Awaited<ReturnType<typeof instance>>) {
      await owner.heard("From zed.", zed);
      await owner.settle();
      const ada = await owner.customerAt(zed);
      await owner.rpc.representative.customerAddIdentity({
        id: ada.id,
        channel: fakeChannel,
        externalId: adaNumber,
      });
    }

    /**
     * The owner corrects Ada's second address and gives the old one to Bob. What Ada said at it stays
     * on her open thread, at an address that's now Bob's.
     */
    async function addressPassedOn(owner: Awaited<ReturnType<typeof instance>>) {
      const { rpc, customerAt } = owner;
      const ada = await customerAt(zed);
      await rpc.representative.customerUpdateIdentity({
        id: ada.id,
        identityId: ada.identities.find((each) => each.externalId === adaNumber)!.id,
        channel: fakeChannel,
        externalId: newAddress,
      });
      await startTestCustomerTurn(owner.deps, {
        representativeId: owner.id,
        message: "Bob speaks.",
        externalId: bobNumber,
      });
      const bob = await customerAt(bobNumber);
      await rpc.representative.customerAddIdentity({
        id: bob.id,
        channel: fakeChannel,
        externalId: adaNumber,
      });
      return { ada, bob };
    }

    const threadOf = async (customerId: string) => (await threadsOfCustomers([customerId]))[0]!;

    /** A hand-off's result on Ada's thread, addressed to the unverified sender it came from. */
    async function resultWaiting(owner: Awaited<ReturnType<typeof instance>>) {
      const [handOff] = await handOffsAt(adaNumber);
      await owner.context().db.transaction((tx) =>
        deliverHandOffResult(owner.context(), tx, {
          assignmentId: handOff!.assignmentId,
          userId: owner.user.id,
          botId: owner.botId,
          status: "done",
          result: { outcome: "Done.", forCustomer: "Your refund is on its way." },
        }),
      );
    }

    const turnStatuses = async (threadId: string) =>
      (
        await getTestDb()
          .select({ status: job.status })
          .from(job)
          .where(
            and(
              eq(job.name, "representative.turn"),
              sql`${job.payload}->>'threadId' = ${threadId}`,
            ),
          )
          .orderBy(job.createdAt)
      ).map((row) => row.status);

    it("clears the wait and cancels the queued Turn when nothing else waits", async () => {
      const owner = await instance({ turnRounds: [handsOff] });
      await twoAddresses(owner);
      await owner.say("I want a refund.", adaNumber);
      await owner.settle();
      const { ada, bob } = await addressPassedOn(owner);
      await resultWaiting(owner);
      const before = await threadOf(ada.id);
      expect(before.waitingFrom).not.toBeNull();
      expect(before.turnId).not.toBeNull();
      const calls = owner.entered.length;

      await owner.rpc.representative.customerDelete({ id: bob.id });

      const after = await threadOf(ada.id);
      expect(after).toMatchObject({ waitingFrom: null, waitingSince: null, turnId: null });
      expect((await turnStatuses(after.id)).at(-1)).toBe("cancelled");
      await owner.settle(batchLongestMs);
      expect(owner.entered).toHaveLength(calls);
    });

    it("gives what's left a new Turn when it still waits, moving where the wait starts", async () => {
      const owner = await instance({
        turnRounds: [handsOff, answers, () => round(), () => round()],
      });
      await twoAddresses(owner);
      await owner.say("I want a refund.", adaNumber);
      await owner.settle();
      const { ada, bob } = await addressPassedOn(owner);
      await resultWaiting(owner);
      await startTestCustomerTurn(owner.deps, {
        representativeId: owner.id,
        message: "Still there?",
        externalId: zed,
      });
      const before = await threadOf(ada.id);
      const calls = owner.entered.length;

      await owner.rpc.representative.customerDelete({ id: bob.id });

      const after = await threadOf(ada.id);
      expect(after.turnId).not.toBeNull();
      expect(after.waitingFrom).toBe(before.waitingFrom! + 1);
      expect(after.waitingSince).not.toBeNull();
      await owner.settle(batchLongestMs);
      expect(owner.entered).toHaveLength(calls + 1);
    });

    it("cancels a Turn that has replied to them, so it sends nothing more, and answers what still waits", async () => {
      let gate: Promise<void> | undefined;
      let open = () => {};
      const owner = await instance({
        turnRounds: [
          () => {
            gate = new Promise<void>((resolve) => (open = resolve));
            return round(
              toolCall({
                name: "reply",
                input: {
                  topic: "general",
                  sources: [autoSource],
                  text: "Hello there.",
                  kind: "small_talk",
                },
              }),
            );
          },
          () =>
            round(
              toolCall({
                name: "reply",
                input: {
                  topic: "general",
                  sources: [autoSource],
                  text: "One more.",
                  kind: "small_talk",
                },
              }),
            ),
          () => round(),
        ],
        held: () => gate,
      });
      const { deps, id, rpc, customerAt, entered, timer } = owner;
      await twoAddresses(owner);
      const ada = await customerAt(zed);
      const first = await threadOf(ada.id);
      const seen = entered.length;
      await startTestCustomerTurn(deps, {
        representativeId: id,
        message: "Hello from Ada.",
        externalId: adaNumber,
      });
      timer.advance(batchLongestMs);
      await vi.waitFor(() => {
        timer.tick();
        expect(entered).toHaveLength(seen + 2);
      }, poll);
      const replied = await threadOf(ada.id);
      expect(replied.turnFrom).toBeNull();
      await startTestCustomerTurn(deps, {
        representativeId: id,
        message: "Still there?",
        externalId: zed,
      });
      const { bob } = await addressPassedOn(owner);

      await rpc.representative.customerDelete({ id: bob.id });

      const after = await threadOf(ada.id);
      expect(after.turnId).not.toBe(replied.turnId);
      gate = undefined;
      open();
      await owner.settle(batchLongestMs);
      const left = await getTestDb()
        .select({ text: representativeThreadMessage.text })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, first.id));
      expect(left.map((row) => row.text)).not.toContain("One more.");
      expect(left.map((row) => row.text)).toContain("Still there?");
      expect(entered).toHaveLength(seen + 3);
    });

    it("cancels a Turn already on their words, and sends nothing", async () => {
      let gate: Promise<void> | undefined;
      const owner = await instance({
        turnRounds: [
          () =>
            round(
              toolCall({
                name: "reply",
                input: {
                  topic: "general",
                  sources: [autoSource],
                  text: "Hello there.",
                  kind: "small_talk",
                },
              }),
            ),
        ],
        held: () => gate,
      });
      const { deps, id, rpc, customerAt, entered, timer } = owner;
      await twoAddresses(owner);
      const ada = await customerAt(zed);
      const first = await threadOf(ada.id);
      let open = () => {};
      gate = new Promise<void>((resolve) => (open = resolve));
      const seen = entered.length;
      await startTestCustomerTurn(deps, {
        representativeId: id,
        message: "Hello from Ada.",
        externalId: adaNumber,
      });
      timer.advance(batchLongestMs);
      await vi.waitFor(() => {
        timer.tick();
        expect(entered).toHaveLength(seen + 1);
      }, poll);
      const { bob } = await addressPassedOn(owner);

      await rpc.representative.customerDelete({ id: bob.id });

      const after = await threadOf(ada.id);
      expect(after).toMatchObject({ turnId: null, turnFrom: null });
      expect((await turnStatuses(first.id)).at(-1)).toBe("cancelled");
      open();
      await owner.settle();
      expect(entered).toHaveLength(seen + 1);
      const left = await getTestDb()
        .select({ text: representativeThreadMessage.text })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, first.id));
      expect(left.map((row) => row.text)).toEqual(["From zed."]);
    });
  });

  it("keeps a hand-off an undo left with them that came from another Customer's address", async () => {
    const { ada, bob, rpc, context, user } = await seeded();
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    const [hers] = await getTestDb()
      .select()
      .from(representativeHandOff)
      .where(
        and(
          eq(representativeHandOff.customerId, ada.id),
          eq(representativeHandOff.externalId, adaNumber),
        ),
      );
    // Where `recordMovedHandOff` and an undo leave a hand-off made on a thread that moved back.
    await getTestDb()
      .update(representativeHandOff)
      .set({ customerId: bob.id })
      .where(eq(representativeHandOff.assignmentId, hers!.assignmentId));

    const { assignmentIds } = await deleteCustomer(context(), user.id, bob.id);

    expect(assignmentIds).not.toContain(hers!.assignmentId);
    const [kept] = await getTestDb()
      .select({ customerId: representativeHandOff.customerId })
      .from(representativeHandOff)
      .where(eq(representativeHandOff.assignmentId, hers!.assignmentId));
    expect(kept?.customerId).toBe(ada.id);
  });

  it("leaves another Customer's data and another owner's alone", async () => {
    const { rpc, ada, carol, other } = await seeded();
    const before = await threadsOfCustomers([carol.id]);
    const otherCustomer = await other.customerAt(adaNumber);

    await rpc.representative.customerDelete({ id: ada.id });

    expect(await threadsOfCustomers([carol.id])).toEqual(before);
    expect((await rpc.representative.customerList()).map((each) => each.id)).toEqual([carol.id]);
    expect((await rpc.representative.customerList())[0]!.profile.map((each) => each.value)).toEqual(
      [`${carol.id} street`],
    );
    expect(await handOffsAt(carolNumber)).toHaveLength(1);
    expect(await other.rpc.representative.customerList()).toEqual([otherCustomer]);
    await expect(other.rpc.representative.customerDelete({ id: carol.id })).rejects.toThrow(
      "Customer not found",
    );
    expect((await rpc.representative.customerList()).map((each) => each.id)).toEqual([carol.id]);
  });

  it("keeps lesson proposals and Gaps, which hold no link to a Customer", async () => {
    const { rpc, ada, user } = await seeded();
    const now = new Date();
    const lessonId = crypto.randomUUID();
    const gapId = crypto.randomUUID();
    await getTestDb()
      .insert(representativeFactProposal)
      .values({
        id: lessonId,
        userId: user.id,
        key: "refund-window",
        proposed: {
          type: "text",
          topic: "Refunds",
          value: "Within 30 days.",
          validFrom: null,
          validUntil: null,
        },
        why: "Seen across your Customers' conversations.",
        postedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      });
    await getTestDb().insert(representativeGap).values({
      id: gapId,
      userId: user.id,
      question: "Do you refund after 30 days?",
      normalized: "do you refund after 30 days",
      firstAt: now,
      lastAt: now,
    });

    await rpc.representative.customerDelete({ id: ada.id });

    const lessons = await getTestDb()
      .select({ id: representativeFactProposal.id, botId: representativeFactProposal.botId })
      .from(representativeFactProposal)
      .where(eq(representativeFactProposal.id, lessonId));
    expect(lessons).toEqual([{ id: lessonId, botId: null }]);
    const gaps = await getTestDb()
      .select({ id: representativeGap.id })
      .from(representativeGap)
      .where(eq(representativeGap.id, gapId));
    expect(gaps).toEqual([{ id: gapId }]);
  });

  it("refuses a Customer already merged away, and one already deleted", async () => {
    const { rpc, ada, bob } = await seeded();
    await expect(rpc.representative.customerDelete({ id: bob.id })).rejects.toThrow(
      "Customer not found",
    );
    expect(await threadsOfCustomers([ada.id])).not.toEqual([]);
    await rpc.representative.customerDelete({ id: ada.id });
    await expect(rpc.representative.customerDelete({ id: ada.id })).rejects.toThrow(
      "Customer not found",
    );
  });

  it("cancels their queued Turn, pass and expiry, and what it can't name finds nothing", async () => {
    const owner = await instance({ started: false });
    const { deps, rpc, id, customerAt } = owner;
    const start = (message: string, externalId: string) =>
      startTestCustomerTurn(deps, { representativeId: id, message, externalId });
    await start("Ada.", adaNumber);
    await start("Bob.", bobNumber);
    const [ada, bob] = [await customerAt(adaNumber), await customerAt(bobNumber)];
    // Both have an open thread, so Bob's closes: its pass and expiry are queued, and his Turn cancelled.
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const threadIds = (await threadsOfCustomers([ada.id])).map((row) => row.id);
    const jobsOfThreads = async () =>
      (
        await getTestDb()
          .select({ name: job.name, status: job.status, payload: job.payload })
          .from(job)
      ).filter((row) => threadIds.includes((row.payload as { threadId: string }).threadId));
    const queued = (await jobsOfThreads()).filter((row) => row.status === "queued");
    expect(queued.map((row) => row.name).sort()).toEqual(
      [
        "representative.customer-summary",
        "representative.thread-expiry",
        "representative.thread-idle",
        "representative.thread-idle",
        "representative.turn",
      ].sort(),
    );

    await rpc.representative.customerDelete({ id: ada.id });

    const left = (await jobsOfThreads()).filter((row) => row.status === "queued");
    expect(left.map((row) => row.name)).toEqual([
      "representative.thread-idle",
      "representative.thread-idle",
    ]);

    await owner.jobs.start();
    await owner.settle(threadIdleMs);
    expect(await rpc.representative.customerList()).toEqual([]);
    expect(await threadsOfCustomers([ada.id])).toEqual([]);
  });

  it("stops a Turn in the middle of its Model call: nothing it does next lands", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const { deps, jobs, timer, entered, botId, rpc, id, customerAt } = await instance({
      turnRounds: [handsOff],
      started: false,
      held,
    });
    await startTestCustomerTurn(deps, {
      representativeId: id,
      message: "I want a refund.",
      externalId: adaNumber,
    });
    timer.advance(batchLongestMs);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    const attempt = jobs.runClaimed(claimed!, {});
    await vi.waitFor(() => expect(entered).toHaveLength(1), poll);
    const ada = await customerAt(adaNumber);
    const [thread] = await threadsOfCustomers([ada.id]);

    await rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(
        and(eq(job.name, "representative.turn"), sql`${job.payload}->>'threadId' = ${thread!.id}`),
      );
    expect(turn?.status).toBe("cancelled");
    open();
    await attempt;
    expect(entered).toHaveLength(1);
    expect(await handOffsAt(adaNumber)).toEqual([]);
    expect(
      await getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId)),
    ).toEqual([]);
    expect(await rpc.representative.customerList()).toEqual([]);
  });

  it("drops their hand-off, so its later result goes nowhere", async () => {
    const { rpc, ada, context, user, carol } = await seeded();
    const [handOff] = await getTestDb()
      .select()
      .from(representativeHandOff)
      .where(eq(representativeHandOff.customerId, ada.id));

    await rpc.representative.customerDelete({ id: ada.id });

    await getTestDb().transaction((tx) =>
      deliverHandOffResult(context(), tx, {
        assignmentId: handOff!.assignmentId,
        userId: user.id,
        botId: crypto.randomUUID(),
        status: "done",
        result: { outcome: "Refunded.", forCustomer: "Your refund is on its way." },
      }),
    );

    expect(await rpc.representative.customerList()).toHaveLength(1);
    expect((await rpc.representative.customerList())[0]!.id).toBe(carol.id);
    expect(
      await getTestDb()
        .select({ id: representativeThreadMessage.id })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.assignmentId, handOff!.assignmentId)),
    ).toEqual([]);
  });

  it("treats a new message from their old identity as a stranger's", async () => {
    const { rpc, ada, heard, customerAt, settle } = await seeded();
    const before = (await rpc.representative.customerList()).length;

    await rpc.representative.customerDelete({ id: ada.id });
    await heard("Hello again.", adaNumber);
    await settle();

    const stranger = await customerAt(adaNumber);
    expect(stranger.id).not.toBe(ada.id);
    expect(stranger.profile).toEqual([]);
    expect(stranger.identities.map((each) => each.verified)).toEqual([false]);
    expect((await rpc.representative.customerList()).length).toBe(before);
    const [thread] = await threadsOfCustomers([stranger.id]);
    const view = await rpc.representative.threadGet({ id: thread!.id });
    expect(view.messages.map((message) => message.text)).toEqual(["Hello again."]);
  });

  it("keeps spend rows, and the totals still add up", async () => {
    const { rpc, ada, user } = await seeded();
    const spend = () =>
      getTestDb()
        .select({ id: usage.id, costMicros: usage.costMicros, inputTokens: usage.inputTokens })
        .from(usage)
        .where(eq(usage.userId, user.id))
        .orderBy(usage.id);
    const before = await spend();
    expect(before).not.toEqual([]);

    await rpc.representative.customerDelete({ id: ada.id });

    expect(await spend()).toEqual(before);
  });

  it("hands back the Assignments of everyone deleted, for their text to be redacted", async () => {
    const { ada, user, context, carol } = await seeded();
    const assignmentsOf = async (customerId: string) =>
      (
        await getTestDb()
          .select({ id: representativeHandOff.assignmentId })
          .from(representativeHandOff)
          .where(
            and(
              eq(representativeHandOff.customerId, customerId),
              eq(representativeHandOff.verified, false),
            ),
          )
      ).map((row) => row.id);
    const expected = await assignmentsOf(ada.id);
    expect(expected).not.toEqual([]);
    expect(await assignmentsOf(carol.id)).not.toEqual([]);

    const { assignmentIds } = await deleteCustomer(context(), user.id, ada.id);

    expect(assignmentIds.sort()).toEqual(expected.sort());
  });
});

describe("the completeness of a Customer's delete", () => {
  it("reaches every table a foreign key links to a Customer, and leaves no linked row behind", async () => {
    const { rpc, ada, bob } = await seeded();
    const [adaThread] = await threadsOfCustomers([ada.id]);
    const decisionId = uuidv7();
    await getTestDb().insert(representativeOutboundDecision).values({
      id: decisionId,
      threadId: adaThread!.id,
      kind: "reply",
      outcome: "hold",
      rule: "caps",
      channel: fakeChannel,
      externalId: adaNumber,
      createdAt: new Date(),
    });
    await getTestDb().insert(representativeHeldMessage).values({
      id: uuidv7(),
      decisionId,
      threadId: adaThread!.id,
      text: "Held for Ada.",
      verified: true,
      createdAt: new Date(),
    });
    const { reached, customerTable, edges } = await rowsLinkedTo([ada.id, bob.id]);
    // Every table a chain of foreign keys ties to a Customer must be seeded above, so a new one
    // can't pass unchecked.
    const linked = new Set([customerTable]);
    for (let grew = true; grew;) {
      grew = false;
      for (const { child, parent } of edges) {
        if (linked.has(parent) && !linked.has(child)) {
          linked.add(child);
          grew = true;
        }
      }
    }
    expect([...linked].filter((table) => !reached.has(table))).toEqual([]);
    const before = new Map<string, number>();
    for (const table of linked) before.set(table, await countOf(table));

    await rpc.representative.customerDelete({ id: ada.id });

    for (const [table, ids] of reached) {
      const key = await primaryKeyOf(table);
      const left = await rowsOf<{ id: string }>(
        sql`select ${sql.raw(`"${key}"`)}::text as id from ${sql.raw(table)} where ${sql.raw(`"${key}"`)}::text in (${tables([...ids])})`,
      );
      expect(left, `${table} keeps rows linked to a deleted Customer`).toEqual([]);
      expect(await countOf(table), `${table} lost rows of someone else`).toBe(
        before.get(table)! - ids.size,
      );
    }
  });

  it("knows each link that isn't a foreign key", async () => {
    // A column naming one of a Customer's rows with no foreign key goes in this list only once the
    // delete covers it: the merge's stored ids are taken with their merge (tested above), a thread's
    // Turn is cancelled (tested above), a hand-off's Assignment is handed back for redaction (tested
    // above), and a message's Assignment goes with the message. An address is matched to another
    // Customer's messages and hand-offs (tested above), and its other columns go with their row.
    const covered = [
      "representative_customer_identity.external_id",
      "representative_customer_merge.hand_off_ids",
      "representative_customer_merge.identity_ids",
      "representative_customer_merge.moved_holds",
      "representative_customer_merge.thread_ids",
      "representative_hand_off.external_id",
      "representative_outbound_decision.external_id",
      "representative_thread.last_external_id",
      "representative_thread.turn_id",
      "representative_thread_message.assignment_id",
      "representative_thread_message.external_id",
    ];
    const columns = await rowsOf<{ name: string }>(sql`
      select c.table_name || '.' || c.column_name as name
      from information_schema.columns c
      where c.table_schema = 'botsdk'
        and (
          c.column_name ~ 'customer'
          or (c.table_name like 'representative_%' and c.column_name ~ 'external_id')
          or (c.table_name like 'representative\_%' and c.column_name ~ '(thread|identity|hand_off|assignment|turn)(_id|_ids)$')
          or (c.table_name like 'representative\_%' and c.data_type = 'jsonb' and c.column_name ~ '(_ids|holds)$')
        )
        and not exists (
          select 1 from pg_constraint k
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
          where k.contype = 'f'
            and k.conrelid = ('botsdk.' || quote_ident(c.table_name))::regclass
            and a.attname = c.column_name
        )
      order by 1`);
    expect(columns.map((row) => row.name)).toEqual(covered);
  });
});
