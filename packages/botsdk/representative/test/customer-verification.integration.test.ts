import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { botAssignment } from "@botsdk/bot/storage";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  fakeChannel,
  startTestCustomerTurn,
  testCustomerTurn,
  type TestCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter } from "@tanstack/ai";
import { representative } from "../src";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeHandOff,
} from "../src/server/db/schema";

/*
 * What an unverified sender gets (ticket #1255): Turns from fake Channels, each saying which rule it
 * has, with a fake Model on real Postgres and a fake clock. The tests read the prompt the Model got,
 * since that is where a leak would be.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;

const sameIdentity = { rule: "sameIdentity" } as const;
const enforcingPass = { rule: "dmarc", pass: true, policy: "reject" } as const;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

type Exported = {
  representative: {
    customers: Array<{
      id: string;
      identities: Array<{
        channel: string;
        externalId: string;
        verifiedContactAt: string | Date | null;
        lapsedAt: string | Date | null;
      }>;
      threads: Array<{
        lastChannel: string;
        lastExternalId: string;
        messages: Array<{ author: string; text: string; channel: string; verified: boolean }>;
      }>;
    }>;
  };
};

const customersOf = async (deps: TestDeps, userId: string) =>
  ((await exportUserData(deps, userId)) as unknown as Exported).representative.customers;

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const replies = (text = "Nine.") => round(toolCall({ name: "reply", input: { text } }));
const quiet = () => round();

const promptOf = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

/** A feature instance with a running runner, a fake Model and a clock the test moves. */
async function instance(rounds: Round[], held?: Promise<void>) {
  const fake = createFakeAdapter({ rounds });
  const timer = fakeJobClock(new Date());
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      await held;
      yield* fake.adapter.chatStream(options);
    },
  };
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
    features: [representative()],
    adapterFor: () => adapter,
    clock: timer.clock.now,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  return { fake, timer, entered, deps: Object.assign(deps, { timer }) };
}

/** A new owner with a Representative serving on a first Release. */
async function ownerWithRepresentative(deps: TestDeps) {
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
  return { user, rpc, id };
}

/** Puts a second identity on `customerId`, as the owner's merge will (#1257): nothing merges by itself. */
const addIdentity = (userId: string, customerId: string, channel: string, externalId: string) =>
  getTestDb()
    .insert(representativeCustomerIdentity)
    .values({ id: uuidv7(), userId, customerId, channel, externalId });

const stateOf = async (deps: TestDeps, userId: string, channel: string) => {
  const customers = await customersOf(deps, userId);
  return customers
    .flatMap((customer) => customer.identities)
    .find((identity) => identity.channel === channel);
};

describe("an owner correcting an address as its message arrives", () => {
  it("doesn't file that message under the corrected identity, nor verify it", async () => {
    const { deps } = await instance([round()]);
    const { user, rpc, id } = await ownerWithRepresentative(deps);
    const made = await rpc.representative.customerCreate({
      channel: fakeChannel,
      externalId: "+1",
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const editor = getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: representativeCustomer.id })
        .from(representativeCustomer)
        .where(eq(representativeCustomer.id, made.id))
        .for("update");
      holding();
      await released;
      await tx
        .update(representativeCustomerIdentity)
        .set({ externalId: "+2" })
        .where(eq(representativeCustomerIdentity.customerId, made.id));
    });
    await held;
    const message = startTestCustomerTurn(deps, {
      representativeId: id,
      externalId: "+1",
      message: "Hello",
      proof: { rule: "sameIdentity" },
    });
    await vi.waitFor(
      async () => {
        const { rows } = await getTestDb().execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
               and query ilike '%representative_customer%'`,
        );
        expect(rows[0]!.waiting).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 },
    );
    release();
    await editor;
    await message;

    const customers = await customersOf(deps, user.id);
    const corrected = customers.find((customer) => customer.id === made.id)!;
    expect(corrected.identities).toMatchObject([{ externalId: "+2", verifiedContactAt: null }]);
    expect(corrected.threads).toEqual([]);
    const stranger = customers.find((customer) => customer.id !== made.id)!;
    expect(stranger.identities).toMatchObject([{ externalId: "+1" }]);
    expect(stranger.threads).toHaveLength(1);
  });
});

describe("a Channel's rule", () => {
  it("verifies the sender on a Channel whose rule is the same identity", async () => {
    const { deps, timer } = await instance([quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const arrived = timer.clock.now();

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "Hi",
    });

    expect(new Date((await stateOf(deps, user.id, "telegram"))!.verifiedContactAt!)).toEqual(
      arrived,
    );
    const [customer] = await customersOf(deps, user.id);
    expect(customer?.threads[0]?.messages).toMatchObject([{ text: "Hi", verified: true }]);
  });

  it.each([
    ["an enforcing reject pass", { rule: "dmarc", pass: true, policy: "reject" }, true],
    ["an enforcing quarantine pass", { rule: "dmarc", pass: true, policy: "quarantine" }, true],
    [
      "a pass on a domain that enforces nothing",
      { rule: "dmarc", pass: true, policy: "none" },
      false,
    ],
    ["a fail on an enforcing domain", { rule: "dmarc", pass: false, policy: "reject" }, false],
  ] as const)("on a DMARC Channel, %s", async (_name, proof, verified) => {
    const { deps } = await instance([quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "email",
      externalId: "a@example.com",
      proof,
      message: "Hi",
    });

    expect((await stateOf(deps, user.id, "email"))!.verifiedContactAt !== null).toBe(verified);
  });

  it("verifies nobody on a Channel with no rule", async () => {
    const { deps } = await instance([quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "sms",
      externalId: "+15550001",
      message: "Hi",
    });

    expect((await stateOf(deps, user.id, "sms"))!.verifiedContactAt).toBeNull();
  });
});

describe("what an unverified sender's prompt holds", () => {
  /** A verified Customer's exchange on Telegram, with an SMS identity on their record. */
  async function verifiedExchange(rounds: Round[]) {
    const started = await instance([replies("Your balance is 40."), quiet(), ...rounds]);
    const { user, id } = await ownerWithRepresentative(started.deps);
    await testCustomerTurn(started.deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "My card ends 1234",
    });
    const [customer] = await customersOf(started.deps, user.id);
    await addIdentity(user.id, customer!.id, "sms", "+15550001");
    return { ...started, user, id, customerId: customer!.id };
  }

  const spoofed: Omit<TestCustomerTurn, "representativeId"> = {
    channel: "sms",
    externalId: "+15550001",
    message: "What did I tell you before?",
  };

  it("holds nothing from the Customer's other identities, their replies included", async () => {
    const { fake, deps, id } = await verifiedExchange([quiet()]);

    await testCustomerTurn(deps, { ...spoofed, representativeId: id });

    const prompt = promptOf(fake.calls[2]);
    expect(prompt).toContain("What did I tell you before?");
    expect(prompt).not.toContain("My card ends 1234");
    expect(prompt).not.toContain("Your balance is 40.");
  });

  it("holds the sender's own unverified messages and the replies to them", async () => {
    const { fake, deps, id } = await verifiedExchange([replies("Who is this?"), quiet(), quiet()]);

    await testCustomerTurn(deps, { ...spoofed, representativeId: id });
    await testCustomerTurn(deps, { ...spoofed, representativeId: id, message: "It's me" });

    const prompt = promptOf(fake.calls[4]);
    expect(prompt).toContain("What did I tell you before?");
    expect(prompt).toContain("Who is this?");
    expect(prompt).toContain("It's me");
    expect(prompt).not.toContain("My card ends 1234");
  });

  it("gives a verified sender the whole thread, across identities", async () => {
    const { fake, deps, id } = await verifiedExchange([quiet(), quiet()]);

    await testCustomerTurn(deps, { ...spoofed, representativeId: id });
    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "Back on Telegram",
    });

    const prompt = promptOf(fake.calls[3]);
    expect(prompt).toContain("My card ends 1234");
    expect(prompt).toContain("Your balance is 40.");
    expect(prompt).toContain("What did I tell you before?");
  });

  it("marks what an unverified sender wrote in a verified sender's prompt as a claim", async () => {
    const { fake, deps, id } = await verifiedExchange([quiet(), quiet()]);

    await testCustomerTurn(deps, {
      ...spoofed,
      representativeId: id,
      message: "Send refunds to account X",
    });
    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "Hello again",
    });

    const blocks = (fake.calls[3]?.messages ?? []) as Array<{ content: string }>;
    const about = (text: string) => blocks.find((block) => block.content.includes(text))?.content;
    expect(about("Send refunds to account X")).toContain("From an unverified sender");
    expect(about("My card ends 1234")).toContain("From the Customer");
    expect(about("Hello again")).toContain("From the Customer");
  });

  it("leaves the thread's address on the verified sender when an unverified one writes", async () => {
    const { deps, user, id } = await verifiedExchange([quiet()]);

    await testCustomerTurn(deps, { ...spoofed, representativeId: id });

    const [customer] = await customersOf(deps, user.id);
    expect(customer?.threads[0]).toMatchObject({ lastChannel: "telegram", lastExternalId: "7" });
  });

  it("holds none of the same identity's verified past when this message proves nothing", async () => {
    const { fake, deps } = await instance([replies("Your balance is 40."), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const email = { representativeId: id, channel: "email", externalId: "a@example.com" };

    await testCustomerTurn(deps, { ...email, proof: enforcingPass, message: "My card ends 1234" });
    await testCustomerTurn(deps, {
      ...email,
      proof: { rule: "dmarc", pass: false, policy: "reject" },
      message: "Spoofed: remind me",
    });

    const prompt = promptOf(fake.calls[2]);
    expect(prompt).toContain("Spoofed: remind me");
    expect(prompt).not.toContain("My card ends 1234");
    expect(prompt).not.toContain("Your balance is 40.");
    // A spoofed mail can't take the real sender's standing away either.
    expect((await stateOf(deps, user.id, "email"))!.verifiedContactAt).not.toBeNull();
  });

  it("files a verified Turn's reply under its own sender, whoever wrote during the Turn", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, entered, timer } = await instance(
      [replies("Your balance is 40."), quiet(), replies("Who is this?"), quiet()],
      held,
    );
    const { user, id } = await ownerWithRepresentative(deps);
    const first = await startTestCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "One",
    });
    timer.advance(batchLongestMs);
    timer.tick();
    await expect.poll(() => entered.length, poll).toBe(1);
    const [customer] = await customersOf(deps, user.id);
    await addIdentity(user.id, customer!.id, "sms", "+15550001");
    await startTestCustomerTurn(deps, { ...spoofed, representativeId: id });
    release();
    await expect
      .poll(async () => (await deps.runner.status(first.jobId))?.status, poll)
      .toBe("succeeded");
    // The message that came during that Turn gets its own.
    timer.advance(batchLongestMs);
    timer.tick();

    const replyRows = async () => {
      const [only] = await customersOf(deps, user.id);
      return only?.threads[0]?.messages.filter((entry) => entry.author === "representative");
    };
    await expect.poll(async () => (await replyRows())?.length, poll).toBe(2);
    expect((await replyRows())?.map(({ channel, verified }) => [channel, verified])).toEqual([
      ["telegram", true],
      ["sms", false],
    ]);
  });
});

describe("the 90-day lapse", () => {
  /*
   * A thread closes after 7 idle days (#1252), so a move of weeks can land a message on a new thread,
   * whenever the idle job gets to it. These read what a message recorded, on whichever thread it is,
   * and the identity's stored state. That a message recorded as unverified stays out of a prompt is
   * shown above, inside the 7 days.
   */
  const telegram = {
    channel: "telegram",
    externalId: "7",
    proof: sameIdentity,
  } as const;

  /** Whether the message saying `text` was recorded as from a verified sender. */
  const recordedVerified = async (deps: TestDeps, userId: string, text: string) => {
    const customers = await customersOf(deps, userId);
    const messages = customers.flatMap((customer) =>
      customer.threads.flatMap((thread) => thread.messages),
    );
    return messages.find((message) => message.text === text)?.verified;
  };

  it("lapses at 90 days without contact and not a minute sooner", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const turn = { ...telegram, representativeId: id };

    await testCustomerTurn(deps, { ...turn, message: "First" });
    timer.advance(90 * day - 60_000);
    const justInside = timer.clock.now();
    await testCustomerTurn(deps, { ...turn, message: "Just inside" });

    expect(await recordedVerified(deps, user.id, "Just inside")).toBe(true);
    const inside = await stateOf(deps, user.id, "telegram");
    expect(new Date(inside!.verifiedContactAt!)).toEqual(justInside);
    expect(inside?.lapsedAt).toBeNull();

    timer.advance(90 * day);
    await testCustomerTurn(deps, { ...turn, message: "At 90 days" });

    expect(await recordedVerified(deps, user.id, "At 90 days")).toBe(false);
  });

  it("counts from the last contact, not from the first verification", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const turn = { ...telegram, representativeId: id };

    await testCustomerTurn(deps, { ...turn, message: "One" });
    timer.advance(80 * day);
    await testCustomerTurn(deps, { ...turn, message: "Two" });
    timer.advance(80 * day);
    await testCustomerTurn(deps, { ...turn, message: "Three" });

    // 160 days from the first, 80 from the last.
    expect(await recordedVerified(deps, user.id, "Three")).toBe(true);

    timer.advance(90 * day);
    await testCustomerTurn(deps, { ...turn, message: "Four" });

    expect(await recordedVerified(deps, user.id, "Four")).toBe(false);
  });

  it("makes the identity unverified at 90 days, and the same identity can't win it back", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const turn = { ...telegram, representativeId: id };

    await testCustomerTurn(deps, { ...turn, message: "Old holder" });
    timer.advance(90 * day);
    const arrived = timer.clock.now();
    await testCustomerTurn(deps, { ...turn, message: "New holder" });

    expect(await recordedVerified(deps, user.id, "New holder")).toBe(false);
    const lapsed = await stateOf(deps, user.id, "telegram");
    expect(lapsed?.verifiedContactAt).toBeNull();
    expect(new Date(lapsed!.lapsedAt!)).toEqual(arrived);

    // The same identity proved nothing new, so a second message doesn't win it back.
    await testCustomerTurn(deps, { ...turn, message: "Second try" });

    expect(await recordedVerified(deps, user.id, "Second try")).toBe(false);
    expect((await stateOf(deps, user.id, "telegram"))?.verifiedContactAt).toBeNull();
  });

  it("lets a fresh enforcing DMARC pass verify again, since it proves itself each time", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const email = { representativeId: id, channel: "email", externalId: "a@example.com" };

    await testCustomerTurn(deps, { ...email, proof: enforcingPass, message: "Before" });
    timer.advance(91 * day);
    await testCustomerTurn(deps, {
      ...email,
      proof: { rule: "dmarc", pass: false, policy: "reject" },
      message: "Failed",
    });

    const lapsed = await stateOf(deps, user.id, "email");
    expect(lapsed?.verifiedContactAt).toBeNull();
    expect(lapsed?.lapsedAt).not.toBeNull();

    const after = timer.clock.now();
    await testCustomerTurn(deps, { ...email, proof: enforcingPass, message: "After" });

    expect(await recordedVerified(deps, user.id, "After")).toBe(true);
    const state = await stateOf(deps, user.id, "email");
    expect(state?.lapsedAt).toBeNull();
    expect(new Date(state!.verifiedContactAt!)).toEqual(after);
  });

  it("isn't kept off by a message that proves nothing", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const email = { representativeId: id, channel: "email", externalId: "a@example.com" };
    const failing = { rule: "dmarc", pass: false, policy: "reject" } as const;

    await testCustomerTurn(deps, { ...email, proof: enforcingPass, message: "Real" });
    timer.advance(89 * day);
    await testCustomerTurn(deps, { ...email, proof: failing, message: "Spoof" });

    expect((await stateOf(deps, user.id, "email"))?.verifiedContactAt).not.toBeNull();

    timer.advance(2 * day);
    await testCustomerTurn(deps, { ...email, proof: failing, message: "Spoof again" });

    expect((await stateOf(deps, user.id, "email"))?.verifiedContactAt).toBeNull();
  });
});

describe("a blocked Customer", () => {
  it("renews nothing, so the lapse runs on through the block", async () => {
    const { deps, timer } = await instance([quiet()]);
    const { user, rpc, id } = await ownerWithRepresentative(deps);
    const telegram = {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
    };
    await testCustomerTurn(deps, { ...telegram, message: "Hi" });
    const [customer] = await customersOf(deps, user.id);
    const before = (await stateOf(deps, user.id, "telegram"))!.verifiedContactAt;
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });

    timer.advance(day);
    await testCustomerTurn(deps, { ...telegram, message: "Still here" });

    expect((await stateOf(deps, user.id, "telegram"))!.verifiedContactAt).toEqual(before);
  });
});

describe("an unverified sender can still get help", () => {
  it("gets a reply and opens an Assignment", async () => {
    const { fake, deps } = await instance([
      round(
        toolCall({ name: "reply", input: { text: "On it." } }),
        toolCall({
          name: "hand_to_bot",
          input: { title: "A refund", instructions: "They want a refund." },
        }),
      ),
      quiet(),
    ]);
    const { user, rpc, id } = await ownerWithRepresentative(deps);
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    await rpc.representative.setBot({ id, botId });

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "sms",
      externalId: "+15550001",
      message: "I want a refund",
    });

    expect(fake.calls).toHaveLength(2);
    const [customer] = await customersOf(deps, user.id);
    expect(customer?.identities[0]?.verifiedContactAt).toBeNull();
    expect(customer?.threads[0]?.messages).toMatchObject([
      { author: "customer", verified: false },
      { author: "representative", text: "On it.", verified: false },
    ]);
    const handOffs = await getTestDb()
      .select({ instructions: botAssignment.instructions })
      .from(representativeHandOff)
      .innerJoin(botAssignment, eq(botAssignment.id, representativeHandOff.assignmentId))
      .where(eq(representativeHandOff.representativeId, id));
    expect(handOffs).toHaveLength(1);
    expect(handOffs[0]?.instructions).toContain("isn't verified");
  });
});

describe("what the owner sees", () => {
  it("shows each identity's verified state on the Customers page and the thread, until it lapses", async () => {
    const { deps, timer } = await instance([quiet()]);
    const { user, rpc, id } = await ownerWithRepresentative(deps);
    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "Hi",
    });
    const [customer] = await customersOf(deps, user.id);
    await addIdentity(user.id, customer!.id, "sms", "+15550001");

    const expected = (telegram: boolean) => [
      { channel: "telegram", verified: telegram },
      { channel: "sms", verified: false },
    ];
    const [thread] = await rpc.representative.threadList({ id });
    expect((await rpc.representative.customerList())[0]?.identities).toMatchObject(expected(true));
    expect((await rpc.representative.threadGet({ id: thread!.id })).messages).toMatchObject([
      { verified: true },
    ]);
    expect((await rpc.representative.threadGet({ id: thread!.id })).identities).toMatchObject(
      expected(true),
    );

    // With no message since: the lapse shows without one.
    timer.advance(90 * day);
    expect((await rpc.representative.customerList())[0]?.identities).toMatchObject(expected(false));
    expect((await rpc.representative.threadGet({ id: thread!.id })).identities).toMatchObject(
      expected(false),
    );
  });

  it("starts an identity the owner re-addresses as unverified, and keeps it when the address is unchanged", async () => {
    const { deps } = await instance([quiet()]);
    const { rpc, id } = await ownerWithRepresentative(deps);
    const telegram = { channel: "telegram", externalId: "7" };
    await testCustomerTurn(deps, {
      ...telegram,
      representativeId: id,
      proof: sameIdentity,
      message: "Hi",
    });
    const [customer] = await rpc.representative.customerList();
    const edit = { id: customer!.id, identityId: customer!.identities[0]!.id };

    const unchanged = await rpc.representative.customerUpdateIdentity({ ...edit, ...telegram });
    expect(unchanged.identities[0]?.verified).toBe(true);

    const moved = await rpc.representative.customerUpdateIdentity({
      ...edit,
      channel: "telegram",
      externalId: "8",
    });
    expect(moved.identities[0]?.verified).toBe(false);
  });
});
