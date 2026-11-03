import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeCustomer, representativeThread } from "../src/server/db/schema";
import { storeReply } from "../src/server/customers";
import { waitingOn } from "../src/server/owner-customers";

/*
 * The owner's Customers and threads (ticket #1251), through the owner API on real Postgres, with
 * the test Customer entry point sending the messages.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

async function instance(rounds: Round[] = []) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: () => fake.adapter,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  return { fake, deps };
}

/** A new owner, with a Representative serving on a first Release unless `serving` is false. */
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
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
  }
  return { user, rpc, id };
}

const replies = (text = "Nine.") => round(toolCall({ name: "reply", input: { text } }));
const quiet = () => round();

describe("an owner's Customers", () => {
  it("lists, adds and renames them, each with its identities, with the Channel in lower case", async () => {
    const { deps } = await instance();
    const { rpc } = await owner(deps);

    expect(await rpc.representative.customerList()).toEqual([]);
    const added = await rpc.representative.customerCreate({
      name: "Ada",
      channel: " SMS ",
      externalId: "+15550001",
    });
    expect(added).toMatchObject({
      name: "Ada",
      blocked: false,
      identities: [{ channel: "sms", externalId: "+15550001" }],
    });

    const more = await rpc.representative.customerAddIdentity({
      id: added.id,
      channel: "email",
      externalId: "ada@example.com",
    });
    expect(more.identities.map((identity) => identity.channel)).toEqual(["sms", "email"]);
    const renamed = await rpc.representative.customerRename({ id: added.id, name: "Ada L." });
    expect(renamed.name).toBe("Ada L.");
    expect(await rpc.representative.customerList()).toHaveLength(1);
  });

  it("keeps one owner's Customers from another, who can use the same identity", async () => {
    const { deps } = await instance();
    const mine = await owner(deps);
    const theirs = await owner(deps);
    const customer = await mine.rpc.representative.customerCreate({
      channel: "sms",
      externalId: "+15550001",
    });

    expect(await theirs.rpc.representative.customerList()).toEqual([]);
    const notFound = { data: { code: "error.customerNotFound" } };
    await expect(
      theirs.rpc.representative.customerSetBlocked({ id: customer.id, blocked: true }),
    ).rejects.toMatchObject(notFound);
    await expect(
      theirs.rpc.representative.customerRename({ id: customer.id, name: "Mine now" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      theirs.rpc.representative.customerAddIdentity({
        id: customer.id,
        channel: "sms",
        externalId: "+15550009",
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      theirs.rpc.representative.customerUpdateIdentity({
        id: customer.id,
        identityId: customer.identities[0]!.id,
        channel: "sms",
        externalId: "+15550009",
      }),
    ).rejects.toMatchObject(notFound);
    expect((await mine.rpc.representative.customerList())[0]).toMatchObject({
      blocked: false,
      identities: [{ channel: "sms", externalId: "+15550001" }],
    });

    // The same number under another owner is an unrelated Customer.
    const other = await theirs.rpc.representative.customerCreate({
      channel: "sms",
      externalId: "+15550001",
    });
    expect(other.id).not.toBe(customer.id);
  });

  it("refuses an identity the owner already has, whether added, edited or created again", async () => {
    const { deps } = await instance();
    const { rpc } = await owner(deps);
    const ada = await rpc.representative.customerCreate({ channel: "sms", externalId: "1" });
    const bob = await rpc.representative.customerCreate({ channel: "sms", externalId: "2" });
    const taken = { data: { code: "error.customerIdentityTaken" } };

    await expect(
      rpc.representative.customerCreate({ channel: "sms", externalId: "1" }),
    ).rejects.toMatchObject(taken);
    await expect(
      rpc.representative.customerAddIdentity({ id: bob.id, channel: "sms", externalId: "1" }),
    ).rejects.toMatchObject(taken);
    await expect(
      rpc.representative.customerUpdateIdentity({
        id: bob.id,
        identityId: bob.identities[0]!.id,
        channel: "sms",
        externalId: "1",
      }),
    ).rejects.toMatchObject(taken);

    // Nothing was left behind by the refusals, and a free identity is accepted.
    expect(await rpc.representative.customerList()).toHaveLength(2);
    const fixed = await rpc.representative.customerUpdateIdentity({
      id: bob.id,
      identityId: bob.identities[0]!.id,
      channel: "whatsapp",
      externalId: "2",
    });
    expect(fixed.identities).toMatchObject([{ channel: "whatsapp", externalId: "2" }]);
    expect(ada.identities).toHaveLength(1);
  });
});

describe("an owner's threads", () => {
  it("lists a Representative's threads and reads one, with its holder and who it waits on", async () => {
    const { deps } = await instance([replies("Nine."), quiet(), quiet()]);
    const { rpc, id } = await owner(deps);

    await testCustomerTurn(deps, {
      representativeId: id,
      message: "When do you open?",
      externalId: "+15550001",
    });

    const [line] = await rpc.representative.threadList({ id });
    expect(line).toMatchObject({
      holder: "representative",
      waitingOn: "customer",
      messageCount: 2,
      lastHeard: { channel: "fake", externalId: "+15550001" },
      customer: { blocked: false },
    });
    const thread = await rpc.representative.threadGet({ id: line!.id });
    expect(thread).toMatchObject({ representativeId: id, holder: "representative" });
    expect(thread.messages.map(({ author, text }) => ({ author, text }))).toEqual([
      { author: "customer", text: "When do you open?" },
      { author: "representative", text: "Nine." },
    ]);

    // The owner's other Representatives have none.
    const second = await rpc.representative.create({ name: "Back office" });
    expect(await rpc.representative.threadList({ id: second.id })).toEqual([]);
  });

  it("is the owner's alone: another owner finds neither the thread nor the Representative", async () => {
    const { deps } = await instance([quiet()]);
    const mine = await owner(deps);
    const theirs = await owner(deps);
    await testCustomerTurn(deps, { representativeId: mine.id, message: "Hello" });
    const [line] = await mine.rpc.representative.threadList({ id: mine.id });

    await expect(theirs.rpc.representative.threadGet({ id: line!.id })).rejects.toMatchObject({
      data: { code: "error.threadNotFound" },
    });
    await expect(theirs.rpc.representative.threadList({ id: mine.id })).rejects.toMatchObject({
      data: { code: "error.representativeNotFound" },
    });
  });

  it("derives who a thread waits on", () => {
    // A Customer's or Bot's word that nothing is on its way to answer waits on no one.
    expect(waitingOn("representative", "customer", false, false)).toBeNull();
    expect(waitingOn("representative", "bot", false, false)).toBeNull();
    expect(waitingOn("representative", "customer", false, true)).toBe("representative");
    expect(waitingOn("representative", "customer", false, false, true)).toBe("bot");
    expect(waitingOn("representative", "representative", false, false)).toBe("customer");
    // A message waiting for a next Turn, which came before the reply.
    expect(waitingOn("representative", "representative", false, true)).toBe("representative");
    expect(waitingOn("owner", "customer", false, false)).toBe("owner");
    expect(waitingOn("closed", "customer", false, false)).toBeNull();
    expect(waitingOn("representative", "customer", true, false)).toBeNull();
  });
});

describe("correcting an identity", () => {
  it("moves an open thread last heard at the old address, so what is sent goes to the new one", async () => {
    const { deps } = await instance([quiet()]);
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(deps, {
      representativeId: id,
      externalId: "+15550001",
      message: "Hello",
      proof: { rule: "sameIdentity" },
    });
    const [line] = await rpc.representative.threadList({ id });
    const [identity] = (await rpc.representative.threadGet({ id: line!.id })).identities;

    await rpc.representative.customerUpdateIdentity({
      id: line!.customer.id,
      identityId: identity!.id,
      channel: "sms",
      externalId: "+15550002",
    });

    expect((await rpc.representative.threadGet({ id: line!.id })).lastHeard).toEqual({
      channel: "sms",
      externalId: "+15550002",
    });
    await rpc.representative.threadTakeOver({ id: line!.id });
    const sent = await rpc.representative.threadSend({ id: line!.id, text: "Found you" });
    expect(sent.messages.at(-1)).toMatchObject({ channel: "sms", externalId: "+15550002" });
  });

  it("takes what waits with it, so the owner's word to the new address answers it", async () => {
    const { deps, fake } = await instance([quiet()]);
    const { rpc, id } = await owner(deps);
    const heard = { representativeId: id, externalId: "+15550001" };
    await testCustomerTurn(deps, { ...heard, message: "Hello", proof: { rule: "sameIdentity" } });
    const [line] = await rpc.representative.threadList({ id });
    await rpc.representative.threadTakeOver({ id: line!.id });
    await testCustomerTurn(deps, { ...heard, message: "Anyone?", proof: { rule: "sameIdentity" } });
    const before = await rpc.representative.threadGet({ id: line!.id });
    const calls = fake.calls.length;

    await rpc.representative.customerUpdateIdentity({
      id: line!.customer.id,
      identityId: before.identities[0]!.id,
      channel: "sms",
      externalId: "+15550002",
    });
    const sent = await rpc.representative.threadSend({ id: line!.id, text: "Here" });

    expect(sent.waitingOn).toBe("customer");
    expect(sent.messages[0]).toMatchObject({ externalId: "+15550001" });
    await rpc.representative.threadHandBack({ id: line!.id });
    expect((await rpc.representative.threadGet({ id: line!.id })).waitingOn).toBe("customer");
    expect(fake.calls).toHaveLength(calls);
  });

  it("leaves a thread last heard at another identity, and a closed thread, where they were", async () => {
    const { deps } = await instance([quiet()]);
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(deps, {
      representativeId: id,
      externalId: "+15550001",
      message: "Hello",
    });
    const [line] = await rpc.representative.threadList({ id });
    const customer = await rpc.representative.customerAddIdentity({
      id: line!.customer.id,
      channel: "email",
      externalId: "a@example.com",
    });
    const email = customer.identities.find((identity) => identity.channel === "email")!;
    const first = customer.identities.find((identity) => identity.channel !== "email")!;
    const lastHeard = async () =>
      (await rpc.representative.threadGet({ id: line!.id })).lastHeard.externalId;

    await rpc.representative.customerUpdateIdentity({
      id: customer.id,
      identityId: email.id,
      channel: "email",
      externalId: "b@example.com",
    });
    expect(await lastHeard()).toBe("+15550001");

    await getTestDb()
      .update(representativeThread)
      .set({ state: "closed" })
      .where(eq(representativeThread.id, line!.id));
    await rpc.representative.customerUpdateIdentity({
      id: customer.id,
      identityId: first.id,
      channel: first.channel,
      externalId: "+15550009",
    });
    expect(await lastHeard()).toBe("+15550001");
  });
});

describe("a blocked Customer", () => {
  it("has their message kept for the owner, with no model call and no reply, until unblocked", async () => {
    const { fake, deps } = await instance([replies("Welcome back."), quiet()]);
    const { rpc, id } = await owner(deps);
    const heard = { representativeId: id, externalId: "+15550001" };

    const customer = await rpc.representative.customerCreate({
      channel: "fake",
      externalId: "+15550001",
    });
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await testCustomerTurn(deps, { ...heard, message: "Let me in" });
    expect(fake.calls).toHaveLength(0);
    const [line] = await rpc.representative.threadList({ id });
    expect(line).toMatchObject({
      messageCount: 1,
      waitingOn: null,
      customer: { id: customer.id, blocked: true },
    });
    const kept = await rpc.representative.threadGet({ id: line!.id });
    expect(kept.messages.map(({ author, text }) => ({ author, text }))).toEqual([
      { author: "customer", text: "Let me in" },
    ]);

    const unblocked = await rpc.representative.customerSetBlocked({
      id: customer.id,
      blocked: false,
    });
    expect(unblocked.blocked).toBe(false);
    await testCustomerTurn(deps, { ...heard, message: "Hello again" });
    expect(fake.calls).toHaveLength(2);
    const after = await rpc.representative.threadGet({ id: line!.id });
    expect(after.messages.map((message) => message.text)).toEqual([
      "Let me in",
      "Hello again",
      "Welcome back.",
    ]);
  });

  it("waits on no one for what was kept during a block, after an unblock", async () => {
    const { fake, deps } = await instance();
    const { rpc, id } = await owner(deps);
    const customer = await rpc.representative.customerCreate({
      channel: "fake",
      externalId: "+15550001",
    });
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
    await testCustomerTurn(deps, {
      representativeId: id,
      externalId: "+15550001",
      message: "Kept",
    });

    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: false });

    const [line] = await rpc.representative.threadList({ id });
    expect(line).toMatchObject({ holder: "representative", waitingOn: null });
    expect(fake.calls).toHaveLength(0);
  });

  it("shows in the owner's export with their name, at the time it was set", async () => {
    const { deps } = await instance();
    const { user, rpc } = await owner(deps, false);
    const customer = await rpc.representative.customerCreate({
      name: "Ada",
      channel: "sms",
      externalId: "+15550001",
    });
    const before = Date.now();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { customers: Array<{ name: string | null; blockedAt: Date | null }> };
    };
    const [row] = exported.representative.customers;
    expect(row?.name).toBe("Ada");
    expect(Math.abs(new Date(row!.blockedAt!).getTime() - before)).toBeLessThan(60_000);
  });

  it("stops a Turn that began before the block from sending more, and keeps the first block's time", async () => {
    const { deps } = await instance([quiet()]);
    const { rpc, id } = await owner(deps);
    await testCustomerTurn(deps, {
      representativeId: id,
      message: "Hello",
      externalId: "+15550001",
    });
    const [line] = await rpc.representative.threadList({ id });
    const sendAnother = () =>
      getTestDb().transaction((tx) =>
        storeReply(
          tx,
          { threadId: line!.id, heard: line!.lastHeard, verified: false },
          "Still here",
          new Date(),
        ),
      );

    expect(await sendAnother()).toEqual({ sent: true });
    await rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });
    expect(await sendAnother()).toMatchObject({
      error: expect.stringContaining("nothing was sent"),
    });
    const thread = await rpc.representative.threadGet({ id: line!.id });
    expect(thread.messages.map((message) => message.text)).toEqual(["Hello", "Still here"]);

    const blockedAt = async () =>
      (
        await getTestDb()
          .select({ at: representativeCustomer.blockedAt })
          .from(representativeCustomer)
          .where(eq(representativeCustomer.id, line!.customer.id))
      )[0]?.at;
    const first = await blockedAt();
    await rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });
    expect(await blockedAt()).toEqual(first);
  });
});
