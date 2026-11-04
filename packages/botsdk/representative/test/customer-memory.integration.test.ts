import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { handOffMessage } from "../src/server/replies";
import {
  representativeCustomerSummary,
  representativeProfileValue,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";

/*
 * A verified Customer is remembered (ticket #1283): from a fake Channel through a Representative
 * Turn with a fake Model on real Postgres, reading the Turn's prompt and the reply gate's answers.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const sameIdentity = { rule: "sameIdentity" } as const;
const phone = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const cites = (text: string, quote: string) =>
  round(
    toolCall({
      name: "reply",
      input: { text, kind: "answer", sources: [{ type: "memory", quote }] },
    }),
  );

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** One owner, with a Representative live and a fake Model answering `rounds`. */
async function instance(rounds: Round[] = [quiet()]) {
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
  return { deps, fake, user, rpc, id };
}
type Instance = Awaited<ReturnType<typeof instance>>;

/** A Customer of the owner reachable at `externalId`, by sms. */
const customer = (rpc: Instance["rpc"], externalId = phone) =>
  rpc.representative.customerCreate({ channel: "sms", externalId });

/** A closed thread of `customerId` with one line from `externalId`, and a summary written at `at`. */
async function summarised(
  { id, user }: { id: string; user: { id: string } },
  customerId: string,
  text: string,
  at: Date,
  externalId = phone,
) {
  const db = getTestDb();
  const threadId = uuidv7();
  await db.insert(representativeThread).values({
    id: threadId,
    customerId,
    representativeId: id,
    state: "closed",
    lastChannel: "sms",
    lastExternalId: externalId,
    messageCount: 1,
  });
  await db.insert(representativeThreadMessage).values({
    id: uuidv7(),
    threadId,
    position: 1,
    author: "customer",
    channel: "sms",
    externalId,
    text: `words for ${text}`,
  });
  await db
    .insert(representativeCustomerSummary)
    .values({ id: uuidv7(), threadId, userId: user.id, text, createdAt: at });
  return threadId;
}

const claimedValue = (userId: string, customerId: string, value: string) =>
  getTestDb()
    .insert(representativeProfileValue)
    .values({
      id: uuidv7(),
      userId,
      customerId,
      fixedField: "preferred_channel",
      value,
      source: "customer",
      status: "claimed",
      recordedAt: new Date("2026-01-01"),
    });

const ask = (world: Instance, message: string, verified = true) =>
  testCustomerTurn(world.deps, {
    representativeId: world.id,
    message,
    externalId: phone,
    channel: "sms",
    proof: verified ? sameIdentity : undefined,
  });

/** The first call's messages, as one string. */
const promptOf = (fake: Instance["fake"]) => JSON.stringify(fake.calls[0]?.messages ?? []);
const answersIn = (call: { messages: unknown } | undefined) =>
  ((call?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content));
const sent = (id: string) =>
  getTestDb()
    .select({
      text: representativeThreadMessage.text,
      sources: representativeThreadMessage.sources,
    })
    .from(representativeThreadMessage)
    .innerJoin(
      representativeThread,
      eq(representativeThread.id, representativeThreadMessage.threadId),
    )
    .where(
      and(
        eq(representativeThread.representativeId, id),
        eq(representativeThreadMessage.author, "representative"),
      ),
    );

describe("what a Turn reads of a Customer", () => {
  it("is the verified Customer's profile and 5 newest summaries, with a sixth left out", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "language",
      value: "Dutch",
    });
    for (let at = 1; at <= 6; at++) {
      await summarised(world, ada.id, `Summary number ${at}.`, new Date(`2026-02-0${at}`));
    }

    await ask(world, "Hi again");

    const prompt = promptOf(world.fake);
    expect(prompt).toContain('language: \\"Dutch\\" (confirmed)');
    for (const at of [2, 3, 4, 5, 6]) expect(prompt).toContain(`Summary number ${at}.`);
    expect(prompt).not.toContain("Summary number 1.");
    // Not in the system text, which is cached per Release.
    expect(JSON.stringify(world.fake.calls[0]?.systemPrompts)).not.toContain("Dutch");
  });

  it("is nothing for an unverified sender, even when the identity's Customer has memory", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "12 Mill Lane",
    });
    await summarised(world, ada.id, "Ada asked about boilers.", new Date("2026-02-01"));

    await ask(world, "Hi again", false);

    const prompt = promptOf(world.fake);
    expect(prompt).not.toContain("12 Mill Lane");
    expect(prompt).not.toContain("boilers");
  });

  it("holds no other Customer's memory", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    const bob = await customer(world.rpc, "+15550002");
    await world.rpc.representative.customerProfileSet({
      id: bob.id,
      field: "address",
      value: "99 Bob Street",
    });
    await summarised(world, bob.id, "Bob asked about pipes.", new Date("2026-02-01"), "+15550002");
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "12 Mill Lane",
    });

    await ask(world, "Hi");

    const prompt = promptOf(world.fake);
    expect(prompt).toContain("12 Mill Lane");
    expect(prompt).not.toContain("Bob");
    expect(prompt).not.toContain("pipes");
  });

  it("is shared by the owner's Representatives and never by another owner's", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    const other = await world.rpc.representative.create({ name: "Back office" });
    await summarised(
      { id: other.id, user: world.user },
      ada.id,
      "Told by the back office.",
      new Date("2026-02-01"),
    );
    // Another owner's Customer on the same address is a different Customer, with its own memory.
    const stranger = await insertUser();
    const theirs = chatRpc({ user: stranger, deps: world.deps });
    const theirRep = await theirs.representative.create({ name: "Theirs" });
    const stranded = await customer(theirs);
    await summarised(
      { id: theirRep.id, user: stranger },
      stranded.id,
      "Secret of the other owner.",
      new Date("2026-02-02"),
    );

    await ask(world, "Hi");

    const prompt = promptOf(world.fake);
    expect(prompt).toContain("Told by the back office.");
    expect(prompt).not.toContain("other owner");
  });

  it("labels a claimed value as claimed", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    await claimedValue(world.user.id, ada.id, "telegram");

    await ask(world, "Hi");

    const prompt = promptOf(world.fake);
    expect(prompt).toContain("preferred channel");
    expect(prompt).toMatch(/telegram.*\(claimed/);
    expect(prompt).not.toMatch(/telegram.*\(confirmed\)/);
  });

  it("leaves out the summary of a thread that holds another person's words", async () => {
    const world = await instance();
    const ada = await customer(world.rpc);
    await summarised(world, ada.id, "Clean summary.", new Date("2026-02-01"));
    // A thread that closed while a merge stood: a line came from an address that is not Ada's now.
    const mixed = await summarised(world, ada.id, "Mixed summary.", new Date("2026-02-02"));
    await getTestDb().insert(representativeThreadMessage).values({
      id: uuidv7(),
      threadId: mixed,
      position: 2,
      author: "customer",
      channel: "sms",
      externalId: "+15559999",
      text: "Someone else",
    });

    await ask(world, "Hi");

    const prompt = promptOf(world.fake);
    expect(prompt).toContain("Clean summary.");
    expect(prompt).not.toContain("Mixed summary.");
  });
});

describe("a reply citing memory", () => {
  it("goes through on an exact quote, and stores its source", async () => {
    const world = await instance([cites("You live at 12 Mill Lane.", "12 Mill Lane"), quiet()]);
    const ada = await customer(world.rpc);
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "12 Mill Lane",
    });

    await ask(world, "What do you have on me?");

    expect(await sent(world.id)).toEqual([
      {
        text: "You live at 12 Mill Lane.",
        sources: [{ type: "memory", quote: "12 Mill Lane" }],
      },
    ]);
  });

  it("refuses a quote that is not in this Customer's memory, even another Customer's", async () => {
    const world = await instance([cites("You live at 99 Bob Street.", "99 Bob Street"), quiet()]);
    const ada = await customer(world.rpc);
    const bob = await customer(world.rpc, "+15550002");
    await world.rpc.representative.customerProfileSet({
      id: bob.id,
      field: "address",
      value: "99 Bob Street",
    });
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "12 Mill Lane",
    });

    await ask(world, "Where do I live?");

    expect((await sent(world.id)).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(world.fake.calls[1])[0]).toMatch(/Nothing was sent.*memory/);
  });

  it("is refused for an unverified sender, who was given no memory", async () => {
    const world = await instance([cites("You live at 12 Mill Lane.", "12 Mill Lane"), quiet()]);
    const ada = await customer(world.rpc);
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "12 Mill Lane",
    });

    await ask(world, "Where do I live?", false);

    expect(answersIn(world.fake.calls[1])[0]).toMatch(/Nothing was sent/);
  });

  it("lets a typed phone number held in memory pass the gate when cited", async () => {
    const world = await instance([
      cites("We will call you on +44 7700 900123.", "+44 7700 900123"),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    const field = await world.rpc.representative.profileFieldAdd({ name: "Mobile" });
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: field.id,
      value: "+44 7700 900123",
    });

    await ask(world, "Which number do you have?");

    expect((await sent(world.id)).map((message) => message.text)).toEqual([
      "We will call you on +44 7700 900123.",
    ]);
  });

  it("lets a house number and postcode, and an email address, held in memory pass when cited", async () => {
    const address = "1200 5600 Main Street, 90210";
    const email = "ada@example.com";
    const world = await instance([
      round(
        toolCall({
          name: "reply",
          input: {
            text: `We will write to ${email} at ${address}.`,
            kind: "answer",
            sources: [
              { type: "memory", quote: address },
              { type: "memory", quote: email },
            ],
          },
        }),
      ),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    const field = await world.rpc.representative.profileFieldAdd({ name: "Email" });
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: address,
    });
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: field.id,
      value: email,
    });

    await ask(world, "Where do you write to me?");

    expect((await sent(world.id)).map((message) => message.text)).toEqual([
      `We will write to ${email} at ${address}.`,
    ]);
  });

  it("refuses that address when it is not cited", async () => {
    const address = "1200 5600 Main Street, 90210";
    const world = await instance([
      round(
        toolCall({
          name: "reply",
          input: { text: `You live at ${address}.`, kind: "small_talk" },
        }),
      ),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: address,
    });

    await ask(world, "Where do I live?");

    const answer = answersIn(world.fake.calls[1])[0];
    expect(answer).toMatch(/Nothing was sent.*phone number you typed/);
  });

  it("refuses the same number when it is not cited", async () => {
    const world = await instance([
      round(
        toolCall({
          name: "reply",
          input: { text: "We will call you on +44 7700 900123.", kind: "small_talk" },
        }),
      ),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    const field = await world.rpc.representative.profileFieldAdd({ name: "Mobile" });
    await world.rpc.representative.customerProfileSet({
      id: ada.id,
      field: field.id,
      value: "+44 7700 900123",
    });

    await ask(world, "Which number?");

    expect(answersIn(world.fake.calls[1])[0]).toMatch(/phone number you typed/);
  });

  it("answers what is remembered, a claimed value too, with a fake Model", async () => {
    const world = await instance([cites("You told us you prefer telegram.", "telegram"), quiet()]);
    const ada = await customer(world.rpc);
    await claimedValue(world.user.id, ada.id, "telegram");

    await ask(world, "What do you remember about me?");

    expect(await sent(world.id)).toEqual([
      {
        text: "You told us you prefer telegram.",
        sources: [{ type: "memory", quote: "telegram" }],
      },
    ]);
  });
});
