import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  startTestCustomerTurn,
  testCustomerTurn,
  type TestCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter } from "@tanstack/ai";
import { representativeCustomer } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";

/*
 * Two Customers become one only by proof or by the owner, and an owner can undo it (ticket #1257):
 * through the test Customer entry point and a fake Channel, a fake Model and the owner API, on real
 * Postgres. The tests read the prompt the Model got, since that is what a merge would expose.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const minute = 60_000;

const toRecord = { rule: "codeToRecord" } as const;
const sameIdentity = { rule: "sameIdentity" } as const;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Sent = { channel: string; externalId: string; kind: "code" | "link"; secret: string };

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const verifies = (input: object = {}) =>
  round(toolCall({ name: "verify_customer", input, id: "verify" }));
const quiet = () => round();
const quietly = (count: number) => Array.from({ length: count }, quiet);

const promptOf = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

/** What the tool told the Model, from the prompt of the Step after it. */
const answerIn = (call: { messages: unknown } | undefined) => {
  const messages = call?.messages as Array<{ role: string; content: unknown }>;
  return JSON.stringify(messages.findLast((message) => message.role === "tool")?.content);
};

async function instance(rounds: Round[], held?: Promise<void>) {
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
  const timer = fakeJobClock(new Date());
  const sent: Sent[] = [];
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [
      representativeFeature(
        {},
        {
          sendProof: async (to, proof) => {
            sent.push({ ...to, ...proof });
          },
        },
      ),
    ],
    adapterFor: () => adapter,
    clock: timer.clock.now,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  return { fake, timer, sent, entered, deps: Object.assign(deps, { timer }) };
}

/** A new owner with a Representative serving on a first Release, unless `serving` is false. */
async function owner(deps: TestDeps, serving = true) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  if (serving) {
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions.", model, tools: ["reply", "verify_customer"] },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
  }
  return { user, rpc, id };
}

type Rpc = Awaited<ReturnType<typeof owner>>["rpc"];

const say = (
  id: string,
  channel: string,
  externalId: string,
  message: string,
  proof?: TestCustomerTurn["proof"],
): TestCustomerTurn => ({ representativeId: id, channel, externalId, message, proof });

/** The owner's Customer with this identity. */
const customerOf = async (rpc: Rpc, externalId: string) => {
  const customer = (await rpc.representative.customerList()).find((each) =>
    each.identities.some((identity) => identity.externalId === externalId),
  );
  if (!customer) throw new Error(`No Customer has ${externalId}`);
  return customer;
};

const threadsOf = async (rpc: Rpc, id: string) => rpc.representative.threadList({ id });

/** Two Customers who have each written to the Representative, so each has an open thread. */
async function twoWithThreads(deps: TestDeps, rpc: Rpc, id: string) {
  await testCustomerTurn(deps, say(id, "sms", "+15550001", "Ada's secret is the blue door"));
  await testCustomerTurn(deps, say(id, "web", "session-1", "Bob's secret is the red door"));
  return {
    ada: await customerOf(rpc, "+15550001"),
    bob: await customerOf(rpc, "session-1"),
  };
}

describe("an owner merging two Customers", () => {
  it("moves the absorbed Customer's identities onto the other, who alone is left", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);

    const merged = await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    expect(merged.id).toBe(ada.id);
    expect(merged.identities.map((identity) => identity.externalId).sort()).toEqual([
      "+15550001",
      "session-1",
    ]);
    expect((await rpc.representative.customerList()).map((customer) => customer.id)).toEqual([
      ada.id,
    ]);
    expect(await rpc.representative.customerMergeList()).toMatchObject([
      {
        how: "owner",
        survivor: { id: ada.id },
        absorbed: { id: bob.id },
        identities: [{ channel: "web", externalId: "session-1" }],
        undoneAt: null,
      },
    ]);
  });

  it("closes the absorbed Customer's open thread when both have one, and the other goes on", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);
    const adaThread = (await threadsOf(rpc, id)).find((each) => each.customer.id === ada.id)!;

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    const threads = await threadsOf(rpc, id);
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.customer.id === ada.id)).toBe(true);
    expect(threads.filter((thread) => thread.holder !== "closed").map((each) => each.id)).toEqual([
      adaThread.id,
    ]);

    // The absorbed identity's next message goes on in the surviving thread.
    await testCustomerTurn(deps, say(id, "web", "session-1", "Me again"));
    const after = await rpc.representative.threadGet({ id: adaThread.id });
    expect(after.messages.map((message) => message.text)).toContain("Me again");
    expect((await threadsOf(rpc, id)).filter((each) => each.holder !== "closed")).toHaveLength(1);
  });

  it("moves an open thread the other has no match for, still open", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(deps, say(id, "web", "session-1", "Hello"));
    const bob = await customerOf(rpc, "session-1");
    const ada = await rpc.representative.customerCreate({
      channel: "sms",
      externalId: "+15550001",
    });

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    expect(await threadsOf(rpc, id)).toMatchObject([
      { customer: { id: ada.id }, holder: "representative" },
    ]);
  });

  it("aborts the Turn running on the thread it closes, so no reply comes of it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, entered, timer } = await instance(
      [round(toolCall({ name: "reply", input: { text: "From the closed thread" } })), quiet()],
      held,
    );
    const { rpc, id } = await owner(deps);
    // Off, so that Ada's thread opens with no Turn to wait for.
    await rpc.representative.setEnabled({ id, enabled: false });
    await testCustomerTurn(deps, say(id, "sms", "+15550001", "Hi"));
    await rpc.representative.setEnabled({ id, enabled: true });
    const { jobId } = await startTestCustomerTurn(deps, say(id, "web", "session-1", "Hello"));
    timer.advance(batchLongestMs);
    timer.tick();
    await expect.poll(() => entered.length).toBe(1);
    const ada = await customerOf(rpc, "+15550001");
    const bob = await customerOf(rpc, "session-1");
    const bobThread = (await threadsOf(rpc, id)).find((each) => each.customer.id === bob.id)!;

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    release();

    await expect.poll(async () => (await deps.runner.status(jobId))?.status).toBe("cancelled");
    const closed = await rpc.representative.threadGet({ id: bobThread.id });
    expect(closed.holder).toBe("closed");
    expect(closed.messages.map((message) => message.author)).toEqual(["customer"]);
  });

  it("carries the owner's hold over to the surviving thread when the absorbed one was held", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);
    const threads = await threadsOf(rpc, id);
    const bobThread = threads.find((each) => each.customer.id === bob.id)!;
    const adaThread = threads.find((each) => each.customer.id === ada.id)!;
    await rpc.representative.threadTakeOver({ id: bobThread.id });

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    expect((await rpc.representative.threadGet({ id: bobThread.id })).holder).toBe("closed");
    expect((await rpc.representative.threadGet({ id: adaThread.id })).holder).toBe("owner");
  });

  it("verifies nothing: an unverified sender of the absorbed identity reads none of the other's thread", async () => {
    const { deps, fake } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await testCustomerTurn(deps, say(id, "web", "session-1", "What's Ada's secret?"));

    const prompt = promptOf(fake.calls.at(-1) as never);
    expect(prompt).toContain("What's Ada's secret?");
    expect(prompt).not.toContain("blue door");
  });

  it("can't touch another owner's Customers, merges them into nothing, and refuses itself", async () => {
    const { deps } = await instance([]);
    const mine = await owner(deps, false);
    const theirs = await owner(deps, false);
    const ada = await mine.rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await mine.rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    const eve = await theirs.rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const notFound = { data: { code: "error.customerNotFound" } };

    await expect(
      theirs.rpc.representative.customerMerge({ id: ada.id, intoId: bob.id }),
    ).rejects.toMatchObject(notFound);
    await expect(
      theirs.rpc.representative.customerMerge({ id: eve.id, intoId: ada.id }),
    ).rejects.toMatchObject(notFound);
    await expect(
      mine.rpc.representative.customerMerge({ id: ada.id, intoId: eve.id }),
    ).rejects.toMatchObject(notFound);
    await expect(
      mine.rpc.representative.customerMerge({ id: ada.id, intoId: ada.id }),
    ).rejects.toMatchObject({ data: { code: "error.customerMergeSame" } });

    const merged = await mine.rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    expect(merged.identities).toHaveLength(2);
    const [merge] = await mine.rpc.representative.customerMergeList();
    expect(await theirs.rpc.representative.customerMergeList()).toEqual([]);
    await expect(
      theirs.rpc.representative.customerMergeUndo({ id: merge!.id }),
    ).rejects.toMatchObject({ data: { code: "error.customerMergeNotFound" } });
    expect((await theirs.rpc.representative.customerList())[0]!.identities).toHaveLength(1);
  });

  it("refuses a blocked Customer on either side, and anything on the absorbed one after", async () => {
    const { deps } = await instance([]);
    const { rpc } = await owner(deps, false);
    const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    const blocked = { data: { code: "error.customerMergeBlocked" } };

    await rpc.representative.customerSetBlocked({ id: bob.id, blocked: true });
    await expect(
      rpc.representative.customerMerge({ id: bob.id, intoId: ada.id }),
    ).rejects.toMatchObject(blocked);
    await expect(
      rpc.representative.customerMerge({ id: ada.id, intoId: bob.id }),
    ).rejects.toMatchObject(blocked);
    await rpc.representative.customerSetBlocked({ id: bob.id, blocked: false });

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    const notFound = { data: { code: "error.customerNotFound" } };
    await expect(
      rpc.representative.customerRename({ id: bob.id, name: "Gone" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      rpc.representative.customerSetBlocked({ id: bob.id, blocked: true }),
    ).rejects.toMatchObject(notFound);
    await expect(
      rpc.representative.customerAddIdentity({ id: bob.id, channel: "sms", externalId: "3" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      rpc.representative.customerMerge({ id: bob.id, intoId: ada.id }),
    ).rejects.toMatchObject(notFound);
    await expect(
      rpc.representative.customerMerge({ id: ada.id, intoId: bob.id }),
    ).rejects.toMatchObject(notFound);

    // None of it took: undoing shows the absorbed Customer as it went.
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });
    const back = (await rpc.representative.customerList()).find((each) => each.id === bob.id);
    expect(back).toMatchObject({ name: null, blocked: false });
    expect(back?.identities.map((each) => each.externalId)).toEqual(["2"]);
  });

  it("shows in the owner's export, and goes with their delete", async () => {
    const { deps } = await instance([]);
    const { rpc, user } = await owner(deps, false);
    const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { customerMerges: unknown[] };
    };
    expect(exported.representative.customerMerges).toMatchObject([
      { survivorCustomerId: ada.id, absorbedCustomerId: bob.id, how: "owner", undoneAt: null },
    ]);

    await deleteUserData(deps, user.id);
    const after = (await exportUserData(deps, user.id)) as unknown as typeof exported;
    expect(after.representative.customerMerges).toEqual([]);
  });
});

describe("an owner undoing a merge", () => {
  it("returns each identity to its original Customer, and doesn't reopen the closed thread", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);
    const threads = await threadsOf(rpc, id);
    const bobThread = threads.find((each) => each.customer.id === bob.id)!;
    const adaThread = threads.find((each) => each.customer.id === ada.id)!;
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const [merge] = await rpc.representative.customerMergeList();

    const undone = await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect(undone.undoneAt).not.toBeNull();
    expect((await customerOf(rpc, "+15550001")).id).toBe(ada.id);
    expect((await customerOf(rpc, "session-1")).id).toBe(bob.id);
    expect(await rpc.representative.threadGet({ id: bobThread.id })).toMatchObject({
      holder: "closed",
      customer: { id: bob.id },
    });
    expect(await rpc.representative.threadGet({ id: adaThread.id })).toMatchObject({
      holder: "representative",
      customer: { id: ada.id },
    });

    // Its next message starts a new thread, the one open thread for that Customer.
    await testCustomerTurn(deps, say(id, "web", "session-1", "Back on my own"));
    const open = (await threadsOf(rpc, id)).filter((each) => each.holder !== "closed");
    expect(open.map((each) => each.customer.id).sort()).toEqual([ada.id, bob.id].sort());
  });

  it("gives back an open thread that moved, open, and doing it twice changes nothing", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(deps, say(id, "web", "session-1", "Hello"));
    const bob = await customerOf(rpc, "session-1");
    const ada = await rpc.representative.customerCreate({
      channel: "sms",
      externalId: "+15550001",
    });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const [merge] = await rpc.representative.customerMergeList();

    const first = await rpc.representative.customerMergeUndo({ id: merge!.id });
    const second = await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect(second.undoneAt).toEqual(first.undoneAt);
    expect(await threadsOf(rpc, id)).toMatchObject([
      { customer: { id: bob.id }, holder: "representative" },
    ]);
  });

  it("keeps an identity the owner added to the survivor since", async () => {
    const { deps } = await instance([]);
    const { rpc } = await owner(deps, false);
    const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await rpc.representative.customerAddIdentity({ id: ada.id, channel: "sms", externalId: "3" });
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect((await customerOf(rpc, "3")).id).toBe(ada.id);
    expect((await customerOf(rpc, "2")).id).toBe(bob.id);
  });

  it("closes a thread that heard from both people, so neither's words reach the other's prompt", async () => {
    const { deps, fake } = await instance(quietly(6));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);
    const adaThread = (await threadsOf(rpc, id)).find((each) => each.customer.id === ada.id)!;
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    // Heard from the absorbed identity, verified, so what is sent now goes to it.
    await testCustomerTurn(deps, say(id, "web", "session-1", "Bob's new secret", sameIdentity));
    expect((await rpc.representative.threadGet({ id: adaThread.id })).lastHeard.externalId).toBe(
      "session-1",
    );
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect((await rpc.representative.threadGet({ id: adaThread.id })).holder).toBe("closed");
    await testCustomerTurn(deps, say(id, "sms", "+15550001", "Ada again", sameIdentity));
    const prompt = promptOf(fake.calls.at(-1) as never);
    expect(prompt).toContain("Ada again");
    expect(prompt).not.toContain("Bob's new secret");
    const open = (await threadsOf(rpc, id)).filter((each) => each.holder !== "closed");
    expect(open.filter((each) => each.customer.id === ada.id)).toHaveLength(1);
  });

  it("refuses until a later merge of the survivor is undone", async () => {
    const { deps } = await instance([]);
    const { rpc } = await owner(deps, false);
    const a = await rpc.representative.customerCreate({ channel: "sms", externalId: "a" });
    const b = await rpc.representative.customerCreate({ channel: "sms", externalId: "b" });
    const c = await rpc.representative.customerCreate({ channel: "sms", externalId: "c" });
    await rpc.representative.customerMerge({ id: a.id, intoId: b.id });
    await rpc.representative.customerMerge({ id: b.id, intoId: c.id });
    const merges = await rpc.representative.customerMergeList();
    const first = merges.find((each) => each.absorbed.id === a.id)!;
    const second = merges.find((each) => each.absorbed.id === b.id)!;

    await expect(rpc.representative.customerMergeUndo({ id: first.id })).rejects.toMatchObject({
      data: { code: "error.customerMergeLater" },
    });

    await rpc.representative.customerMergeUndo({ id: second.id });
    expect((await customerOf(rpc, "a")).id).toBe(b.id);
    expect((await customerOf(rpc, "c")).id).toBe(c.id);
    await rpc.representative.customerMergeUndo({ id: first.id });
    expect((await customerOf(rpc, "a")).id).toBe(a.id);
    expect((await customerOf(rpc, "b")).id).toBe(b.id);
  });

  it("closes a thread with words from an address the owner has corrected since", async () => {
    const { deps } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);
    const { bob } = await twoWithThreads(deps, rpc, id);
    await rpc.representative.customerMerge({
      id: bob.id,
      intoId: (await customerOf(rpc, "+15550001")).id,
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "Bob's words", sameIdentity));
    const moved = await customerOf(rpc, "session-1");
    const identity = moved.identities.find((each) => each.externalId === "session-1")!;
    await rpc.representative.customerUpdateIdentity({
      id: moved.id,
      identityId: identity.id,
      channel: "web",
      externalId: "session-2",
    });
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    const open = (await threadsOf(rpc, id)).filter((each) => each.holder !== "closed");
    expect(open).toEqual([]);
  });

  it("gives back a thread held only because of the merge, and no other", async () => {
    const { deps } = await instance(quietly(6));
    const { rpc, id } = await owner(deps);
    const { ada, bob } = await twoWithThreads(deps, rpc, id);
    const threads = await threadsOf(rpc, id);
    const bobThread = threads.find((each) => each.customer.id === bob.id)!;
    const adaThread = threads.find((each) => each.customer.id === ada.id)!;
    await rpc.representative.threadTakeOver({ id: bobThread.id });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect(await rpc.representative.threadGet({ id: adaThread.id })).toMatchObject({
      holder: "representative",
      customer: { id: ada.id },
    });

    // The survivor's own hold stays: the merge didn't make it.
    await rpc.representative.threadTakeOver({ id: adaThread.id });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const [second] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: second!.id });
    expect((await rpc.representative.threadGet({ id: adaThread.id })).holder).toBe("owner");
  });

  it("passes on a block set since the merge, to both", async () => {
    const { deps } = await instance([]);
    const { rpc } = await owner(deps, false);
    const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await rpc.representative.customerSetBlocked({ id: ada.id, blocked: true });
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect((await customerOf(rpc, "1")).blocked).toBe(true);
    expect((await customerOf(rpc, "2")).blocked).toBe(true);
  });

  it("ends a code on its way across the two, so it can't merge them again", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      ...quietly(5),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    const bob = await customerOf(rpc, "session-1");
    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });

    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));

    expect((await customerOf(rpc, "session-1")).id).toBe(bob.id);
    expect(await rpc.representative.customerMergeList()).toHaveLength(1);
  });
});

describe("a code merging a new identity's Customer", () => {
  it("merges the sender's Customer into the identity's on record, which its Turn then reads", async () => {
    const { deps, sent, fake } = await instance([
      quiet(),
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(
      deps,
      say(id, "email", "ada@example.com", "Ada's secret is the blue door", {
        rule: "dmarc",
        pass: true,
        policy: "reject",
      }),
    );
    const ada = await customerOf(rpc, "ada@example.com");
    const adaThread = (await threadsOf(rpc, id))[0]!;

    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    const bob = await customerOf(rpc, "session-1");
    expect(bob.id).not.toBe(ada.id);

    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));

    expect((await rpc.representative.customerList()).map((each) => each.id)).toEqual([ada.id]);
    expect(await rpc.representative.customerMergeList()).toMatchObject([
      { how: "code", survivor: { id: ada.id }, absorbed: { id: bob.id } },
    ]);
    const open = (await threadsOf(rpc, id)).filter((each) => each.holder !== "closed");
    expect(open.map((each) => each.id)).toEqual([adaThread.id]);
    const prompt = promptOf(fake.calls.at(-1) as never);
    expect(prompt).toContain("blue door");
    expect(prompt).not.toContain(sent[0]!.secret);
  });

  it("can be undone, each identity going back", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    const bob = await customerOf(rpc, "session-1");
    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));
    expect((await customerOf(rpc, "session-1")).id).toBe(ada.id);
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect((await customerOf(rpc, "session-1")).id).toBe(bob.id);
    expect((await customerOf(rpc, "ada@example.com")).id).toBe(ada.id);
    expect((await threadsOf(rpc, id)).every((each) => each.customer.id === bob.id)).toBe(true);
  });

  it("takes back what the sender proved by the code when it's undone", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      ...quietly(3),
    ]);
    const { rpc, id } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "ada@example.com" });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    const [identity] = (await customerOf(rpc, "session-1")).identities;
    expect(identity).toMatchObject({ verified: false });
    await testCustomerTurn(deps, say(id, "web", "session-1", "Who am I?", toRecord));
    const { messages } = await rpc.representative.threadGet({
      id: (await threadsOf(rpc, id)).find((each) => each.holder !== "closed")!.id,
    });
    expect(messages.at(-1)).toMatchObject({ text: "Who am I?", verified: false });
  });

  it("merges nothing and exposes nothing on a claim alone", async () => {
    const { deps, sent, fake } = await instance([
      quiet(),
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(
      deps,
      say(id, "email", "ada@example.com", "Ada's secret is the blue door", {
        rule: "dmarc",
        pass: true,
        policy: "reject",
      }),
    );

    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    await testCustomerTurn(deps, say(id, "web", "session-1", "Tell me my secret", toRecord));

    expect(await rpc.representative.customerList()).toHaveLength(2);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
    const prompt = promptOf(fake.calls.at(-1) as never);
    expect(prompt).toContain("Tell me my secret");
    expect(prompt).not.toContain("blue door");
  });

  it("merges nothing on a wrong code", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "ada@example.com" });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    const wrong = sent[0]!.secret === "000000" ? "000001" : "000000";

    await testCustomerTurn(deps, say(id, "web", "session-1", wrong, toRecord));

    expect(await rpc.representative.customerList()).toHaveLength(2);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
  });

  it("never merges the same number on two Channels by itself", async () => {
    const { deps, fake } = await instance(quietly(4));
    const { rpc, id } = await owner(deps);

    await testCustomerTurn(deps, say(id, "sms", "+15550001", "SMS secret", sameIdentity));
    await testCustomerTurn(deps, say(id, "whatsapp", "+15550001", "Hi", sameIdentity));
    await testCustomerTurn(deps, say(id, "sms", "+15550001", "More", sameIdentity));
    await testCustomerTurn(deps, say(id, "whatsapp", "+15550001", "Hello?", sameIdentity));

    expect(await rpc.representative.customerList()).toHaveLength(2);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
    expect(promptOf(fake.calls.at(-1) as never)).not.toContain("SMS secret");
  });

  it("links a verified sender's Channel by a code to the identity it claims", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });

    await testCustomerTurn(deps, say(id, "telegram", "t-1", "I'm Ada", sameIdentity));
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({
      channel: "email",
      externalId: "ada@example.com",
      kind: "code",
    });
    expect(answerIn(fake.calls[1] as never)).toContain("If that identity can receive a proof");

    await testCustomerTurn(deps, say(id, "telegram", "t-1", sent[0]!.secret, sameIdentity));

    expect((await customerOf(rpc, "t-1")).id).toBe(ada.id);
  });

  it("answers a verified sender with no claim as before, and sends nothing", async () => {
    const { deps, sent, fake } = await instance([verifies(), quiet()]);
    const { id } = await owner(deps);

    await testCustomerTurn(deps, say(id, "telegram", "t-1", "Hi", sameIdentity));

    expect(answerIn(fake.calls[1] as never)).toContain("already verified");
    expect(sent).toEqual([]);
  });

  it("tells a verified sender claiming their own address they are verified, and sends nothing", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "telegram", externalId: "t-1" }),
      ...quietly(2),
    ]);
    const { rpc, id } = await owner(deps);

    await testCustomerTurn(deps, say(id, "telegram", "t-1", "It's me", sameIdentity));
    expect(answerIn(fake.calls[1] as never)).toContain("already verified");
    await testCustomerTurn(deps, say(id, "telegram", "t-1", "123456", sameIdentity));

    expect(sent).toEqual([]);
    const { messages } = await rpc.representative.threadGet({
      id: (await threadsOf(rpc, id))[0]!.id,
    });
    expect(messages.at(-1)!.text).toBe("123456");
  });

  it("sends a verified sender nothing for an identity of their own Customer", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "me@example.com" }),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    const me = await rpc.representative.customerCreate({ channel: "telegram", externalId: "t-1" });
    await rpc.representative.customerAddIdentity({
      id: me.id,
      channel: "email",
      externalId: "me@example.com",
    });

    await testCustomerTurn(deps, say(id, "telegram", "t-1", "It's me", sameIdentity));

    expect(sent).toEqual([]);
    expect(answerIn(fake.calls[1] as never)).toContain("If that identity can receive a proof");
  });

  it("links no sender from a Channel that can be spoofed, however lately proved", async () => {
    const { deps, sent, fake } = await instance([
      verifies(),
      quiet(),
      quiet(),
      verifies({ channel: "email", externalId: "theirs@example.com" }),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    await rpc.representative.customerCreate({
      channel: "email",
      externalId: "theirs@example.com",
    });
    const roundTrip = { rule: "codeRoundTrip" } as const;
    await testCustomerTurn(deps, say(id, "sms", "+15550001", "Check me", roundTrip));
    await expect.poll(() => sent.length).toBe(1);
    await testCustomerTurn(deps, say(id, "sms", "+15550001", sent[0]!.secret, roundTrip));

    await testCustomerTurn(deps, say(id, "sms", "+15550001", "Link theirs", roundTrip));

    expect(answerIn(fake.calls[4] as never)).toContain("If that identity can receive a proof");
    expect(sent).toHaveLength(1);
    expect(await rpc.representative.customerList()).toHaveLength(2);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
  });

  it("holds no other Customer for a message of digits when no code of the sender's is live", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      ...quietly(3),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    deps.timer.advance(11 * minute);

    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = () => {};
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const hold = getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: representativeCustomer.id })
        .from(representativeCustomer)
        .where(eq(representativeCustomer.id, ada.id))
        .for("update");
      holding();
      await released;
    });
    await held;

    try {
      await testCustomerTurn(deps, say(id, "web", "session-1", "Order 987654", toRecord));
    } finally {
      release();
      await hold;
    }

    expect(await rpc.representative.customerList()).toHaveLength(2);
  });

  it("doesn't let a verified sender claim for a Customer with other identities, nor be told so", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "ada@example.com" });
    const bob = await rpc.representative.customerCreate({ channel: "telegram", externalId: "t-1" });
    await rpc.representative.customerAddIdentity({
      id: bob.id,
      channel: "email",
      externalId: "bob@example.com",
    });

    await testCustomerTurn(deps, say(id, "telegram", "t-1", "I'm Ada", sameIdentity));

    expect(sent).toEqual([]);
    expect(answerIn(fake.calls[1] as never)).toContain("If that identity can receive a proof");
  });

  it("voids the code when the sender's Customer has gained another identity since it went", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    const bob = await customerOf(rpc, "session-1");
    await rpc.representative.customerAddIdentity({
      id: bob.id,
      channel: "email",
      externalId: "bob@example.com",
    });

    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));

    expect((await customerOf(rpc, "session-1")).id).toBe(bob.id);
    expect((await customerOf(rpc, "ada@example.com")).id).toBe(ada.id);
    expect(await rpc.representative.customerMergeList()).toEqual([]);
    const { messages } = await rpc.representative.threadGet({
      id: (await threadsOf(rpc, id))[0]!.id,
    });
    expect(messages.at(-1)!.text).toContain("can't be used now");
    expect(messages.at(-1)!.verified).toBe(false);
  });

  it("voids the code when the identity it went to has since been blocked", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);
    await rpc.representative.customerSetBlocked({ id: ada.id, blocked: true });

    await testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord));

    expect(await rpc.representative.customerMergeList()).toEqual([]);
    expect(await rpc.representative.customerList()).toHaveLength(2);
  });

  it("takes the code and another message at once with no deadlock, the second on the surviving thread", async () => {
    const { deps, sent, timer } = await instance([
      verifies({ channel: "email", externalId: "ada@example.com" }),
      ...quietly(5),
    ]);
    const { rpc, id } = await owner(deps);
    const ada = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "ada@example.com",
    });
    await testCustomerTurn(deps, say(id, "web", "session-1", "I'm Ada", toRecord));
    await expect.poll(() => sent.length).toBe(1);

    await Promise.all([
      testCustomerTurn(deps, say(id, "web", "session-1", sent[0]!.secret, toRecord)),
      testCustomerTurn(deps, say(id, "web", "session-1", "And another thing", toRecord)),
    ]);
    timer.advance(minute);

    expect((await customerOf(rpc, "session-1")).id).toBe(ada.id);
    const open = (await threadsOf(rpc, id)).filter((each) => each.holder !== "closed");
    expect(open).toHaveLength(1);
  });
});
