import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  startTestCustomerTurn,
  testCustomerTurn,
  type TestCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter } from "@tanstack/ai";
import { representative } from "../src";
import { representativeCustomerIdentity, representativeHandOff } from "../src/server/db/schema";

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
  return { fake, timer, entered, deps };
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

describe("a Channel's rule", () => {
  it("verifies the sender on a Channel whose rule is the same identity", async () => {
    const { deps, timer } = await instance([quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: sameIdentity,
      message: "Hi",
    });

    expect(new Date((await stateOf(deps, user.id, "telegram"))!.verifiedContactAt!)).toEqual(
      timer.clock.now(),
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
    const { deps, entered } = await instance(
      [replies("Your balance is 40."), replies("Who is this?"), quiet(), quiet()],
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
    await expect.poll(() => entered.length, poll).toBe(1);
    const [customer] = await customersOf(deps, user.id);
    await addIdentity(user.id, customer!.id, "sms", "+15550001");
    const second = await startTestCustomerTurn(deps, {
      ...spoofed,
      representativeId: id,
    });
    await expect.poll(() => entered.length, poll).toBe(2);
    release();
    for (const { jobId } of [first, second]) {
      await expect
        .poll(async () => (await deps.runner.status(jobId))?.status, poll)
        .toBe("succeeded");
    }

    const [only] = await customersOf(deps, user.id);
    const sent = only?.threads[0]?.messages.filter((entry) => entry.author === "representative");
    expect(sent?.map(({ channel, verified }) => [channel, verified]).sort()).toEqual([
      ["sms", false],
      ["telegram", true],
    ]);
  });
});

describe("the 90-day lapse", () => {
  const telegram = {
    channel: "telegram",
    externalId: "7",
    proof: sameIdentity,
  } as const;

  it("keeps a verified identity verified just inside 90 days without contact", async () => {
    const { fake, deps, timer } = await instance([
      replies("Your balance is 40."),
      quiet(),
      quiet(),
    ]);
    const { id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, {
      ...telegram,
      representativeId: id,
      message: "My card ends 1234",
    });
    timer.advance(90 * day - 60_000);
    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "Back" });

    expect(promptOf(fake.calls[2])).toContain("My card ends 1234");
  });

  it("counts from the last contact, not from the first verification", async () => {
    const { fake, deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "One" });
    timer.advance(80 * day);
    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "Two" });
    timer.advance(80 * day);
    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "Three" });

    expect(promptOf(fake.calls[2])).toContain("One");
  });

  it("makes the identity unverified at 90 days, so the number's next holder reads nothing", async () => {
    const { fake, deps, timer } = await instance([
      replies("Your balance is 40."),
      quiet(),
      quiet(),
      quiet(),
    ]);
    const { user, id } = await ownerWithRepresentative(deps);

    await testCustomerTurn(deps, {
      ...telegram,
      representativeId: id,
      message: "My card ends 1234",
    });
    timer.advance(90 * day);
    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "New holder" });

    expect(promptOf(fake.calls[2])).toContain("New holder");
    expect(promptOf(fake.calls[2])).not.toContain("My card ends 1234");
    expect(promptOf(fake.calls[2])).not.toContain("Your balance is 40.");
    const state = await stateOf(deps, user.id, "telegram");
    expect(state?.verifiedContactAt).toBeNull();
    expect(new Date(state!.lapsedAt!)).toEqual(timer.clock.now());

    // The same identity proved nothing new, so a second message doesn't win it back.
    await testCustomerTurn(deps, { ...telegram, representativeId: id, message: "Second try" });
    expect(promptOf(fake.calls[3])).not.toContain("My card ends 1234");
    expect((await stateOf(deps, user.id, "telegram"))?.verifiedContactAt).toBeNull();
  });

  it("lets a fresh enforcing DMARC pass verify again, since it proves itself each time", async () => {
    const { fake, deps, timer } = await instance([quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const email = {
      representativeId: id,
      channel: "email",
      externalId: "a@example.com",
      proof: enforcingPass,
    };

    await testCustomerTurn(deps, { ...email, message: "Before" });
    timer.advance(91 * day);
    await testCustomerTurn(deps, { ...email, message: "After" });

    expect(promptOf(fake.calls[1])).toContain("Before");
    const state = await stateOf(deps, user.id, "email");
    expect(state?.lapsedAt).toBeNull();
    expect(new Date(state!.verifiedContactAt!)).toEqual(timer.clock.now());
  });

  it("isn't kept off by a message that proves nothing", async () => {
    const { deps, timer } = await instance([quiet(), quiet(), quiet()]);
    const { user, id } = await ownerWithRepresentative(deps);
    const email = { representativeId: id, channel: "email", externalId: "a@example.com" };
    const failing = { rule: "dmarc", pass: false, policy: "reject" } as const;

    await testCustomerTurn(deps, { ...email, proof: enforcingPass, message: "Real" });
    timer.advance(89 * day);
    await testCustomerTurn(deps, { ...email, proof: failing, message: "Spoof" });
    timer.advance(2 * day);
    await testCustomerTurn(deps, { ...email, proof: failing, message: "Spoof again" });

    expect((await stateOf(deps, user.id, "email"))?.verifiedContactAt).toBeNull();
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
      .select()
      .from(representativeHandOff)
      .where(and(eq(representativeHandOff.representativeId, id)));
    expect(handOffs).toHaveLength(1);
  });
});
