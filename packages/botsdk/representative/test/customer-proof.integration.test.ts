import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import {
  startTestCustomerTurn,
  testCustomerTurn,
  type TestCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { otherSpelling } from "@ai-chat/test-support/signatures";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter } from "@tanstack/ai";
import { requestProof } from "../src/server/customer-proof";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeVerification,
} from "../src/server/db/schema";
import { customerSummaryMarker } from "../src/server/customer-summary";
import { noCustomerChannel } from "../src/server/customer-proof";
import { representativeFeature } from "../src/server/plugin";
import { proofLastsMs } from "../src/server/verification";

/*
 * Proving who a Customer is (ticket #1256): Turns from fake Channels, with a fake Model on real
 * Postgres and a fake clock. What was "sent" is what the fake Channel received, and the tests read
 * the prompt the Model got, since that is where a code would leak.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const minute = 60_000;
const day = 24 * 60 * minute;

const roundTrip = { rule: "codeRoundTrip" } as const;
/**
 * The code-to-record rule, on a stand-in Channel ("chat"): a claim in the chat sends the code. Web chat
 * has the rule too, but its visitors ask in the chat window instead (#1350, web-chat.integration).
 */
const toRecord = { rule: "codeToRecord" } as const;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Sent = { channel: string; externalId: string; kind: "code" | "link"; secret: string };

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const verifies = (input: object = {}) =>
  round(toolCall({ name: "verify_customer", input, id: "verify" }));
const quiet = () => round();

const promptOf = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

/** What the tool told the Model, from the prompt of the Step after it. */
const answerIn = (call: { messages: unknown } | undefined) => {
  const messages = call?.messages as Array<{ role: string; content: unknown }>;
  return JSON.stringify(messages.findLast((message) => message.role === "tool")?.content);
};

/** A feature instance with a running runner, a fake Model, a fake Channel and a clock the test moves. */
async function instance(rounds: Round[], held?: Promise<void>, failing?: () => never) {
  const fake = createFakeAdapter({ rounds });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      // The pass after a close isn't what these tests script: it hears nothing and writes nothing.
      if (JSON.stringify(options.systemPrompts).includes(customerSummaryMarker)) {
        yield* round();
        return;
      }
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
          ...noCustomerChannel,
          sendProof:
            failing ??
            (async (to, proof) => {
              sent.push({ ...to, ...proof });
            }),
        },
      ),
    ],
    adapterFor: () => adapter,
    clock: timer.clock.now,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  return { fake, timer, sent, deps: Object.assign(deps, { timer }), entered };
}

/** A new owner with a Representative serving on a first Release that has chosen `verify_customer`. */
async function owner(deps: TestDeps, tools?: Array<"reply" | "hand_to_bot" | "verify_customer">) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  const draft = {
    jobText: "Answer questions.",
    model,
    tools: tools ?? ["reply", "hand_to_bot", "verify_customer"],
  };
  await rpc.representative.updateDraft({ id, draft });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  return { user, rpc, id };
}

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
        id: string;
        messages: Array<{ author: string; text: string; verified: boolean }>;
      }>;
    }>;
  };
};

const customersOf = async (deps: TestDeps, userId: string) =>
  ((await exportUserData(deps, userId)) as unknown as Exported).representative.customers;

const identityOf = async (deps: TestDeps, userId: string, externalId: string) =>
  (await customersOf(deps, userId))
    .flatMap((customer) => customer.identities)
    .find((identity) => identity.externalId === externalId)!;

const messagesOf = async (deps: TestDeps, userId: string, externalId: string) =>
  (await customersOf(deps, userId))
    .find((customer) => customer.identities.some((each) => each.externalId === externalId))!
    .threads.flatMap((thread) => thread.messages);

const sms = (id: string, message: string): TestCustomerTurn => ({
  representativeId: id,
  channel: "sms",
  externalId: "+15550001",
  proof: roundTrip,
  message,
});

describe("the verify_customer tool", () => {
  it("is on the code-defined list, and a new draft doesn't choose it", async () => {
    const { deps } = await instance([]);
    const user = await insertUser();
    const rpc = chatRpc({ user, deps });

    const { id } = await rpc.representative.create({ name: "Front desk" });

    expect((await rpc.representative.get({ id })).draft.tools).not.toContain("verify_customer");
    await expect(
      rpc.representative.updateDraft({ id, draft: { tools: ["verify_customer"] } }),
    ).resolves.toBeDefined();
  });

  it("reaches a Turn only when its Release chose it", async () => {
    const { deps, fake } = await instance([quiet(), quiet()]);
    const without = await owner(deps, ["reply"]);
    const chosen = await owner(deps);

    await testCustomerTurn(deps, sms(without.id, "Hi"));
    await testCustomerTurn(deps, sms(chosen.id, "Hi"));

    const toolsOf = (index: number) =>
      (fake.calls[index] as unknown as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      );
    expect(toolsOf(0)).not.toContain("verify_customer");
    expect(toolsOf(1)).toContain("verify_customer");
  });
});

describe("a code round trip on SMS", () => {
  it("sends only when the tool asks, to the number the message came from, whatever the Model claims", async () => {
    const { deps, sent } = await instance([
      quiet(),
      verifies({ channel: "sms", externalId: "+15559999" }),
      quiet(),
    ]);
    const { id } = await owner(deps);

    await testCustomerTurn(deps, sms(id, "Hi"));
    expect(sent).toEqual([]);

    await testCustomerTurn(deps, sms(id, "It's me"));

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ channel: "sms", externalId: "+15550001", kind: "code" });
    expect(sent[0]!.secret).toMatch(/^\d{6}$/);
  });

  it("a correct code verifies the identity, and neither the code nor its message reaches a prompt", async () => {
    const { deps, sent, fake } = await instance([verifies(), quiet(), quiet()]);
    const { id, user } = await owner(deps);

    await testCustomerTurn(deps, sms(id, "What's my balance?"));
    await expect.poll(() => sent.length).toBe(1);
    const code = sent[0]!.secret;
    expect((await identityOf(deps, user.id, "+15550001")).verifiedContactAt).toBeNull();

    await testCustomerTurn(deps, sms(id, `the code is ${code} thanks`));

    expect((await identityOf(deps, user.id, "+15550001")).verifiedContactAt).not.toBeNull();
    for (const call of fake.calls) expect(promptOf(call)).not.toContain(code);
    const messages = await messagesOf(deps, user.id, "+15550001");
    expect(JSON.stringify(messages)).not.toContain(code);
    expect(JSON.stringify(messages)).not.toContain("thanks");
    expect(messages.findLast(({ author }) => author === "customer")).toMatchObject({
      verified: true,
    });
    // The Turn that follows reads the thread as verified, the question it was waiting on included.
    expect(promptOf(fake.calls.at(-1))).toContain("What's my balance?");
  });
});
describe("what a code allows", () => {
  /** A Customer on SMS who has been sent a code. */
  async function codeSent(extra: Round[]) {
    const started = await instance([verifies(), quiet(), ...extra]);
    const account = await owner(started.deps);
    await testCustomerTurn(started.deps, sms(account.id, "Hi"));
    await expect.poll(() => started.sent.length).toBe(1);
    return { ...started, ...account, code: started.sent[0]!.secret };
  }
  const standingOn = (deps: TestDeps, userId: string) => identityOf(deps, userId, "+15550001");
  const wrongTo = (code: string) => (code === "000000" ? "000001" : "000000");

  it("leaves no record of a proof once the thread closes idle", async () => {
    const { timer } = await codeSent([]);
    expect(await getTestDb().select().from(representativeVerification)).toHaveLength(1);

    timer.advance(7 * 24 * 60 * minute);
    timer.tick();

    await expect
      .poll(() => getTestDb().select().from(representativeVerification), { timeout: 10_000 })
      .toEqual([]);
  });

  it("exports how long a passed code lasts", async () => {
    const { deps, user, id, code, timer } = await codeSent([quiet()]);

    const passedAt = timer.clock.now().getTime();
    await testCustomerTurn(deps, sms(id, code));

    const exported = await exportUserData(deps, user.id);
    expect(JSON.stringify(exported)).toContain(new Date(passedAt + proofLastsMs).toISOString());
  });

  it("hides a code typed while the owner holds the thread, and the Turn after Hand back knows it passed", async () => {
    const { deps, user, id, code, fake, rpc, timer } = await codeSent([quiet()]);
    const [summary] = await rpc.representative.threadList({ id });
    await rpc.representative.threadTakeOver({ id: summary!.id });

    await testCustomerTurn(deps, sms(id, code));
    const held = await rpc.representative.threadGet({ id: summary!.id });
    expect(JSON.stringify(held.messages)).not.toContain(code);
    expect((await standingOn(deps, user.id)).verifiedContactAt).not.toBeNull();

    const before = fake.calls.length;
    await rpc.representative.threadHandBack({ id: summary!.id });
    timer.advance(batchLongestMs);
    timer.tick();
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBeGreaterThan(before);

    const turn = fake.calls.at(-1)!;
    expect(JSON.stringify(turn.messages)).not.toContain(code);
    expect(JSON.stringify(turn.messages)).toContain("is verified");
    expect(JSON.stringify(turn.messages)).not.toContain("isn't verified");
  });

  it("catches a code in another script's digits, and passes it", async () => {
    const { deps, user, id, code, fake } = await codeSent([quiet()]);
    const arabic = [...code].map((digit) => String.fromCodePoint(0x660 + Number(digit))).join("");

    await testCustomerTurn(deps, sms(id, arabic));

    expect((await standingOn(deps, user.id)).verifiedContactAt).not.toBeNull();
    expect(promptOf(fake.calls.at(-1))).not.toContain(arabic);
  });

  it("tells a Model whose sender is already verified that no proof is needed", async () => {
    const { deps, id, code, sent, fake } = await codeSent([verifies(), quiet()]);

    await testCustomerTurn(deps, sms(id, code));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toHaveLength(1);
    expect(answerIn(fake.calls.at(-1))).toContain("already verified");
    expect(answerIn(fake.calls.at(-1))).not.toContain("on its way");
  });

  it("sends nothing to a sender who passed a code since their Turn began", async () => {
    const { deps, user, id, code, sent, timer } = await codeSent([quiet()]);
    await testCustomerTurn(deps, sms(id, code));
    const [customer] = await customersOf(deps, user.id);

    const proof = await getTestDb().transaction((tx) =>
      requestProof(tx, {
        keyring: ["a-test-secret"],
        channel: noCustomerChannel,
        userId: user.id,
        thread: {
          threadId: customer!.threads[0]!.id,
          heard: { channel: "sms", externalId: "+15550001" },
          verified: false,
          proofRule: "codeRoundTrip",
        },
        claimed: null,
        now: timer.clock.now(),
      }),
    );

    expect(proof).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the owner blocks the Customer while a proof waits for its lock", async () => {
    const { deps, user, timer } = await codeSent([]);
    const [customer] = await customersOf(deps, user.id);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const blocker = getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: representativeCustomerIdentity.id })
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.userId, user.id))
        .for("update");
      holding();
      await released;
    });
    await held;
    const asked = getTestDb().transaction((tx) =>
      requestProof(tx, {
        keyring: ["a-test-secret"],
        channel: noCustomerChannel,
        userId: user.id,
        thread: {
          threadId: customer!.threads[0]!.id,
          heard: { channel: "sms", externalId: "+15550001" },
          verified: false,
          proofRule: "codeRoundTrip",
        },
        claimed: null,
        now: timer.clock.now(),
      }),
    );
    await vi.waitFor(
      async () => {
        const { rows } = await getTestDb().execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
               and query ilike '%representative_customer_identity%'`,
        );
        expect(rows[0]!.waiting).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 },
    );
    await getTestDb()
      .update(representativeCustomer)
      .set({ blockedAt: timer.clock.now() })
      .where(eq(representativeCustomer.id, customer!.id));
    release();
    await blocker;

    expect(await asked).toBeNull();
  });

  it("passes only the stored hash as it was written, not another spelling of its bytes", async () => {
    const { deps, id, user, code } = await codeSent([quiet()]);
    const [row] = await getTestDb().select().from(representativeVerification);
    await getTestDb()
      .update(representativeVerification)
      .set({ codeHash: otherSpelling(row!.codeHash!) })
      .where(eq(representativeVerification.id, row!.id));

    await testCustomerTurn(deps, sms(id, code));

    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
  });

  it("stores only a hash of a code", async () => {
    const { code } = await codeSent([]);

    const rows = await getTestDb().select().from(representativeVerification);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("refuses a code after 10 minutes, on a fake clock, and still hides it", async () => {
    const { deps, user, id, code, timer, fake } = await codeSent([quiet()]);

    timer.advance(10 * minute);
    await testCustomerTurn(deps, sms(id, code));

    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
    for (const call of fake.calls) expect(promptOf(call)).not.toContain(code);
  });

  it("voids a code after 5 wrong tries, and hides each try from the Model", async () => {
    const { deps, user, id, code, fake } = await codeSent([
      quiet(),
      quiet(),
      quiet(),
      quiet(),
      quiet(),
      quiet(),
    ]);
    const wrong = wrongTo(code);

    for (let tries = 0; tries < 5; tries++) await testCustomerTurn(deps, sms(id, wrong));
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();

    await testCustomerTurn(deps, sms(id, code));

    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
    for (const call of fake.calls) {
      expect(promptOf(call)).not.toContain(wrong);
      expect(promptOf(call)).not.toContain(code);
    }
  });

  it("passes on the 5th try after 4 wrong ones", async () => {
    const { deps, user, id, code } = await codeSent([quiet(), quiet(), quiet(), quiet(), quiet()]);

    for (let tries = 0; tries < 4; tries++) await testCustomerTurn(deps, sms(id, wrongTo(code)));
    await testCustomerTurn(deps, sms(id, code));

    expect((await standingOn(deps, user.id)).verifiedContactAt).not.toBeNull();
  });

  it("lets digits in a sentence reach the Model as said, and counts them as a try", async () => {
    const { deps, user, id, code, fake } = await codeSent([quiet()]);
    const order = wrongTo(code);

    await testCustomerTurn(deps, sms(id, `My order is ${order}`));

    expect(promptOf(fake.calls.at(-1))).toContain(`My order is ${order}`);
    const [row] = await getTestDb().select().from(representativeVerification);
    expect(row!.attempts).toBe(1);
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
  });

  it("gives a message full of guesses only the tries that are left", async () => {
    const { deps, user, id, code } = await codeSent([quiet(), quiet()]);
    const guesses = Array.from({ length: 5 }, (_, index) =>
      String((Number(code) + index + 1) % 1_000_000).padStart(6, "0"),
    );

    await testCustomerTurn(deps, sms(id, `try ${guesses.join(" x ")} x ${code}`));

    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
    await testCustomerTurn(deps, sms(id, code));
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
  });

  it.each([
    [
      "spaced in pairs",
      (code: string) => `${code.slice(0, 2)} ${code.slice(2, 4)} ${code.slice(4)}`,
    ],
    ["spaced digit by digit", (code: string) => code.split("").join(" ")],
    ["with a dot", (code: string) => `${code.slice(0, 3)}.${code.slice(3)}`],
    ["with an en dash", (code: string) => `${code.slice(0, 3)}\u2013${code.slice(3)}`],
    [
      "in full-width digits",
      (code: string) =>
        code.replace(/\d/g, (digit) => String.fromCodePoint(0xff10 + Number(digit))),
    ],
  ])("catches a code typed %s", async (_name, typed) => {
    const { deps, user, id, code, fake } = await codeSent([quiet()]);

    await testCustomerTurn(deps, sms(id, typed(code)));

    expect((await standingOn(deps, user.id)).verifiedContactAt).not.toBeNull();
    expect(promptOf(fake.calls.at(-1))).not.toContain(typed(code));
  });

  it("hides a code sent back from the identity it went to, and voids it, so spoofing that identity is no free guess", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
      quiet(),
      quiet(),
    ]);
    const { user, id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });
    const web: TestCustomerTurn = {
      representativeId: id,
      channel: "chat",
      externalId: "session-1",
      proof: toRecord,
      message: "I'm a",
    };
    await testCustomerTurn(deps, web);
    await expect.poll(() => sent.length).toBe(1);
    const code = sent[0]!.secret;

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "email",
      externalId: "a@example.com",
      proof: { rule: "dmarc", pass: false, policy: "none" },
      message: code,
    });

    expect(promptOf(fake.calls.at(-1))).not.toContain(code);
    expect((await identityOf(deps, user.id, "a@example.com")).verifiedContactAt).toBeNull();
    await testCustomerTurn(deps, { ...web, message: code });
    expect((await identityOf(deps, user.id, "session-1")).verifiedContactAt).toBeNull();
  });

  it.each([
    ["typed twice", (code: string) => `${code} ${code}`],
    ["with a digit after it", (code: string) => `${code} 2`],
    ["with a comma", (code: string) => `${code.slice(0, 3)},${code.slice(3)}`],
    ["with double spaces", (code: string) => code.split("").join("  ")],
  ])("hides a code %s, voiding it rather than counting it", async (_name, typed) => {
    const { deps, user, id, code, fake } = await codeSent([quiet(), quiet()]);

    await testCustomerTurn(deps, sms(id, typed(code)));

    expect(promptOf(fake.calls.at(-1))).not.toContain(code.slice(0, 3) + code.slice(3));
    expect(JSON.stringify(await messagesOf(deps, user.id, "+15550001"))).not.toContain(typed(code));
    await testCustomerTurn(deps, sms(id, code));
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
  });

  it("hides a code typed from another identity of the same Customer", async () => {
    const { deps, user, id, code, fake, rpc } = await codeSent([quiet(), quiet()]);
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerAddIdentity({
      id: customer!.id,
      channel: "telegram",
      externalId: "7",
    });

    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "telegram",
      externalId: "7",
      proof: { rule: "sameIdentity" },
      message: code,
    });

    expect(promptOf(fake.calls.at(-1))).not.toContain(code);
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
  });

  it("tells the Model outside any fence whether this Turn's sender is verified, which no message can forge", async () => {
    const { deps, id, code, fake } = await codeSent([quiet(), quiet()]);
    const systemOf = (call: unknown) => JSON.stringify((call as { messages: unknown }).messages);

    expect(systemOf(fake.calls[0])).toContain("isn't verified");
    await testCustomerTurn(deps, sms(id, code));
    expect(systemOf(fake.calls.at(-1))).toContain("is verified");
    expect(systemOf(fake.calls.at(-1))).not.toContain("isn't verified");
  });

  it("isn't sent once the owner has blocked the Customer mid-Turn", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { deps, sent, entered, timer } = await instance([verifies(), quiet()], held);
    const { user, id, rpc } = await owner(deps);

    const { jobId } = await startTestCustomerTurn(deps, sms(id, "Hi"));
    timer.advance(batchLongestMs);
    timer.tick();
    await expect.poll(() => entered.length).toBe(1);
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });
    release();
    await expect
      .poll(async () => (await deps.runner.status(jobId))?.status, { timeout: 20_000 })
      .toMatch(/^(succeeded|failed|cancelled)$/);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });

  it("isn't sent to an SMS sender a code already vouches for", async () => {
    const { deps, id, code, sent } = await codeSent([quiet(), verifies(), quiet()]);
    await testCustomerTurn(deps, sms(id, code));

    await testCustomerTurn(deps, sms(id, "Again?"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toHaveLength(1);
  });

  it("can be passed once", async () => {
    const { deps, id, code, timer, user, fake } = await codeSent([quiet(), quiet()]);

    await testCustomerTurn(deps, sms(id, code));
    timer.advance(proofLastsMs);
    await testCustomerTurn(deps, sms(id, code));

    const messages = await messagesOf(deps, user.id, "+15550001");
    expect(messages.at(-1)!.verified).toBe(false);
    expect(promptOf(fake.calls.at(-1))).not.toContain(code);
  });

  it("proves only the sender it was sent for: another number holding it proves nothing", async () => {
    const { deps, user, id, code, fake } = await codeSent([quiet()]);

    await testCustomerTurn(deps, { ...sms(id, code), externalId: "+15550002" });

    expect((await identityOf(deps, user.id, "+15550002")).verifiedContactAt).toBeNull();
    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
    expect(fake.calls).toHaveLength(3);
  });

  it("vouches for an hour, unrenewed, so a spoofed number has an hour and not 90 days", async () => {
    const { deps, user, id, code, timer } = await codeSent([quiet(), quiet(), quiet()]);
    await testCustomerTurn(deps, sms(id, code));

    timer.advance(proofLastsMs - minute);
    await testCustomerTurn(deps, sms(id, "Still me"));
    timer.advance(2 * minute);
    await testCustomerTurn(deps, sms(id, "A spoofed text"));

    const messages = (await messagesOf(deps, user.id, "+15550001")).filter(
      ({ author }) => author === "customer",
    );
    expect(messages.at(-2)).toMatchObject({ text: "Still me", verified: true });
    expect(messages.at(-1)).toMatchObject({ text: "A spoofed text", verified: false });
  });

  it("can't be passed by a blocked Customer, whose message hides it all the same", async () => {
    const { deps, user, id, code, rpc } = await codeSent([]);
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });

    await testCustomerTurn(deps, sms(id, code));

    expect((await standingOn(deps, user.id)).verifiedContactAt).toBeNull();
    expect(JSON.stringify(await messagesOf(deps, user.id, "+15550001"))).not.toContain(code);
  });

  it("dies when the owner corrects the address it was sent for", async () => {
    const { deps, user, id, code, rpc } = await codeSent([quiet()]);
    const [customer] = await customersOf(deps, user.id);
    const { identities } = await rpc.representative.customerUpdateIdentity({
      id: customer!.id,
      identityId: (await rpc.representative.customerList())[0]!.identities[0]!.id,
      channel: "sms",
      externalId: "+15557777",
    });
    expect(identities[0]!.externalId).toBe("+15557777");

    await testCustomerTurn(deps, { ...sms(id, code), externalId: "+15557777" });

    expect((await identityOf(deps, user.id, "+15557777")).verifiedContactAt).toBeNull();
  });
});

describe("a code to an identity on record, claimed in the chat", () => {
  const web = (id: string, message: string): TestCustomerTurn => ({
    representativeId: id,
    channel: "chat",
    externalId: "session-1",
    proof: toRecord,
    message,
  });

  it("goes to the claimed identity on record, and passing it verifies the sender", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "Email", externalId: "a@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { user, id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a@example.com"));
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ channel: "email", externalId: "a@example.com", kind: "code" });

    await testCustomerTurn(deps, web(id, sent[0]!.secret));

    expect((await identityOf(deps, user.id, "session-1")).verifiedContactAt).not.toBeNull();
    // The code proves the sender; it says nothing of the identity it was sent to.
    expect((await identityOf(deps, user.id, "a@example.com")).verifiedContactAt).toBeNull();
  });

  it("answers the Model the same whether or not the claim is on record, and sends only when it is", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
      verifies({ channel: "email", externalId: "invented@example.com" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a"));
    await testCustomerTurn(deps, { ...web(id, "I'm b"), externalId: "session-2" });
    await expect.poll(() => sent.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.externalId).toBe("a@example.com");
    expect(answerIn(fake.calls[1])).toContain("on its way");
    expect(answerIn(fake.calls[3])).toEqual(answerIn(fake.calls[1]));
  });

  it("won't send a Customer with other identities a code by way of someone else's", async () => {
    const { deps, sent } = await instance([
      quiet(),
      verifies({ channel: "email", externalId: "b@example.com" }),
      quiet(),
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
    ]);
    const { user, id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "b@example.com" });
    await testCustomerTurn(deps, web(id, "Hi"));
    const customer = (await customersOf(deps, user.id)).find((row) =>
      row.identities.some((identity) => identity.externalId === "session-1"),
    );
    await rpc.representative.customerAddIdentity({
      id: customer!.id,
      channel: "email",
      externalId: "a@example.com",
    });
    await testCustomerTurn(deps, web(id, "I'm b"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toEqual([]);

    await testCustomerTurn(deps, web(id, "I'm a"));
    await expect.poll(() => sent.length).toBe(1);

    expect(sent[0]).toMatchObject({ externalId: "a@example.com" });
  });

  it("tells a Model that claims half an identity to give both parts", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ externalId: "a@example.com" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a"));

    expect(sent).toEqual([]);
    expect(answerIn(fake.calls[1])).not.toContain("on its way");
  });

  it("keeps a code on its way when a later claim leads nowhere", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
      verifies({ channel: "email", externalId: "A@EXAMPLE.COM" }),
      quiet(),
      quiet(),
    ]);
    const { user, id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a"));
    await expect.poll(() => sent.length).toBe(1);
    await testCustomerTurn(deps, web(id, "Did you get that?"));
    await testCustomerTurn(deps, web(id, sent[0]!.secret));

    expect((await identityOf(deps, user.id, "session-1")).verifiedContactAt).not.toBeNull();
  });

  it("answers the same when the Channel throws, and the Turn goes on", async () => {
    const { deps, fake } = await instance(
      [verifies({ channel: "email", externalId: "a@example.com" }), quiet()],
      undefined,
      () => {
        throw new Error("a bad address");
      },
    );
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a"));

    expect(answerIn(fake.calls[1])).toContain("on its way");
  });

  it("gets through when two senders claim each other at the same moment", async () => {
    const { deps } = await instance([quiet(), quiet()]);
    const { user, id } = await owner(deps);
    const heard = (externalId: string) => ({ channel: "chat", externalId });
    await testCustomerTurn(deps, { ...web(id, "Hi"), channel: "chat", externalId: "session-a" });
    await testCustomerTurn(deps, { ...web(id, "Hi"), channel: "chat", externalId: "session-b" });
    const customers = await customersOf(deps, user.id);
    const threadOf = (externalId: string) =>
      customers.find((customer) =>
        customer.identities.some((identity) => identity.externalId === externalId),
      )!.threads[0]!.id;
    const claimEachOther = (sender: string, claimed: string) =>
      getTestDb().transaction((tx) =>
        requestProof(tx, {
          keyring: ["a-test-secret"],
          channel: noCustomerChannel,
          userId: user.id,
          thread: {
            threadId: threadOf(sender),
            heard: heard(sender),
            verified: false,
            proofRule: "codeToRecord",
          },
          claimed: heard(claimed),
          now: new Date(),
        }),
      );
    // Holding both rows stops each claim at its first lock, and letting go of them together has
    // each take that lock at once: locks taken in the sender's order would then deadlock.
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const blocker = getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: representativeCustomerIdentity.id })
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.userId, user.id))
        .for("update");
      holding();
      await released;
    });
    await held;
    const claims = Promise.all([
      claimEachOther("session-a", "session-b"),
      claimEachOther("session-b", "session-a"),
    ]);
    await vi.waitFor(
      async () => {
        const { rows } = await getTestDb().execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
               and query ilike '%representative_customer_identity%'`,
        );
        expect(rows[0]!.waiting).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000 },
    );
    release();
    await blocker;

    const sent = await claims;

    expect(sent.map((proof) => proof?.to.externalId)).toEqual(["session-b", "session-a"]);
  });

  it("proves an unverified sender from a Turn that Hand back queued, with no new message", async () => {
    const { deps, fake, sent, timer } = await instance([quiet(), verifies(), quiet()]);
    const { id, rpc } = await owner(deps);
    await testCustomerTurn(deps, sms(id, "Hi"));
    const [summary] = await rpc.representative.threadList({ id });
    await rpc.representative.threadTakeOver({ id: summary!.id });
    await testCustomerTurn(deps, sms(id, "Still there?"));

    await rpc.representative.threadHandBack({ id: summary!.id });
    timer.advance(batchLongestMs);
    timer.tick();

    await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1);
    expect(sent[0]).toMatchObject({ externalId: "+15550001", kind: "code" });
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("isn't verified");
  });

  it("treats a bare code the same after a claim on record and one that isn't", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
      quiet(),
      verifies({ channel: "email", externalId: "nobody@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });

    await testCustomerTurn(deps, web(id, "I'm a"));
    await expect.poll(() => sent.length).toBe(1);
    const guess = sent[0]!.secret === "000000" ? "000001" : "000000";
    await testCustomerTurn(deps, web(id, guess));
    const stranger = { ...web(id, "I'm nobody"), externalId: "session-2" };
    await testCustomerTurn(deps, stranger);
    await testCustomerTurn(deps, { ...stranger, message: guess });

    expect(promptOf(fake.calls[2])).not.toContain(guess);
    expect(promptOf(fake.calls[5])).not.toContain(guess);
    const lastOf = (index: number) => {
      const messages = fake.calls[index]!.messages as Array<{ content: unknown }>;
      return JSON.stringify(messages.at(-1)!.content);
    };
    expect(lastOf(5)).toEqual(lastOf(2));
  });

  it("can't be passed from a claim that isn't on record, whatever is guessed", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "nobody@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { user, id } = await owner(deps);

    await testCustomerTurn(deps, web(id, "I'm nobody"));
    await testCustomerTurn(deps, web(id, "000000"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
    expect((await identityOf(deps, user.id, "session-1")).verifiedContactAt).toBeNull();
  });

  it("can't use up a number's own codes: strangers' claims of it don't lock its holder out", async () => {
    const claim = { channel: "sms", externalId: "+15550001" };
    const { deps, sent } = await instance([
      ...Array.from({ length: 5 }).flatMap(() => [verifies(claim), quiet()]),
      verifies(),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate(claim);
    for (let tries = 0; tries < 5; tries++) {
      await testCustomerTurn(deps, { ...web(id, "Me"), externalId: `session-${tries}` });
    }
    await expect.poll(() => sent.length).toBe(5);

    await testCustomerTurn(deps, sms(id, "It's really me"));

    await expect.poll(() => sent.length).toBe(6);
  });

  it("limits what one sender can ask for, on any claim", async () => {
    const claim = { channel: "email", externalId: "a@example.com" };
    const { deps, sent } = await instance(
      Array.from({ length: 6 }).flatMap(() => [verifies(claim), quiet()]),
    );
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate(claim);

    for (let tries = 0; tries < 6; tries++) await testCustomerTurn(deps, web(id, "Me"));
    await expect.poll(() => sent.length).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toHaveLength(5);
  });

  it("sends nothing with no claim, or for another owner's Customer", async () => {
    const { deps, sent } = await instance([
      verifies(),
      quiet(),
      verifies({ channel: "email", externalId: "theirs@example.com" }),
      quiet(),
    ]);
    const { id } = await owner(deps);
    const other = await owner(deps);
    await other.rpc.representative.customerCreate({
      channel: "email",
      externalId: "theirs@example.com",
    });

    await testCustomerTurn(deps, web(id, "Hi"));
    await testCustomerTurn(deps, web(id, "I'm theirs"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });

  it("sends nothing to a blocked Customer's identity", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    const made = await rpc.representative.customerCreate({
      channel: "email",
      externalId: "a@example.com",
    });
    await rpc.representative.customerSetBlocked({ id: made.id, blocked: true });

    await testCustomerTurn(deps, web(id, "I'm a"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });

  it("stops sending to one identity after 5 in an hour, without saying so, and resumes after", async () => {
    const claim = { channel: "email", externalId: "a@example.com" };
    const { deps, sent, timer, fake } = await instance(
      Array.from({ length: 7 }).flatMap(() => [verifies(claim), quiet()]),
    );
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate(claim);

    for (let tries = 0; tries < 6; tries++) {
      await testCustomerTurn(deps, { ...web(id, "Me"), externalId: `session-${tries}` });
    }
    await expect.poll(() => sent.length).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(5);
    expect(answerIn(fake.calls[11])).toEqual(answerIn(fake.calls[1]));

    timer.advance(60 * minute);
    await testCustomerTurn(deps, { ...web(id, "Me"), externalId: "session-later" });

    await expect.poll(() => sent.length).toBe(6);
  });

  it("reaches nothing from a draft's test conversation", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "a@example.com" });
    await rpc.representative.customerCreate({ channel: "chat", externalId: "session-1" });
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [{ name: "Proves", message: "I'm a", expect: [{ kind: "not_handed_off" }] }],
      },
    });

    await rpc.representative.runTests({ id });
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(answerIn(fake.calls[1])).toContain("on its way");
    expect(JSON.stringify(fake.calls[0]?.messages)).toContain("isn't verified");
    expect(sent).toEqual([]);
  });
});

describe("a lapsed identity", () => {
  const telegram = (id: string, message: string): TestCustomerTurn => ({
    representativeId: id,
    channel: "telegram",
    externalId: "7",
    proof: { rule: "sameIdentity" },
    message,
  });

  it("gets no code at its own number, whose next holder would read it", async () => {
    const { deps, sent, timer } = await instance([
      verifies(),
      quiet(),
      quiet(),
      verifies({ channel: "sms", externalId: "+15559999" }),
      quiet(),
    ]);
    const { id } = await owner(deps);
    await testCustomerTurn(deps, sms(id, "Hi"));
    await expect.poll(() => sent.length).toBe(1);
    await testCustomerTurn(deps, sms(id, sent[0]!.secret));

    timer.advance(91 * day);
    await testCustomerTurn(deps, sms(id, "Back again"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toHaveLength(1);
  });

  it("verifies again by a code to another identity on record, and its lapse ends", async () => {
    const { deps, sent, timer } = await instance([
      quiet(),
      verifies({ channel: "email", externalId: "a@example.com" }),
      quiet(),
      quiet(),
      quiet(),
    ]);
    const { user, id, rpc } = await owner(deps);
    await testCustomerTurn(deps, telegram(id, "Hi"));
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerAddIdentity({
      id: customer!.id,
      channel: "email",
      externalId: "a@example.com",
    });

    timer.advance(91 * day);
    await testCustomerTurn(deps, telegram(id, "Back again"));
    expect((await identityOf(deps, user.id, "7")).lapsedAt).not.toBeNull();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.externalId).toBe("a@example.com");

    await testCustomerTurn(deps, telegram(id, sent[0]!.secret));
    await testCustomerTurn(deps, telegram(id, "Thanks"));

    expect((await identityOf(deps, user.id, "7")).lapsedAt).toBeNull();
    const messages = (await messagesOf(deps, user.id, "7")).filter(
      ({ author }) => author === "customer",
    );
    expect(messages.at(-1)).toMatchObject({ text: "Thanks", verified: true });
  });

  it("can't verify again by a code to an identity of another Customer, such as one its new holder made", async () => {
    const { deps, sent, timer } = await instance([
      quiet(),
      quiet(),
      verifies({ channel: "email", externalId: "attacker@example.com" }),
      quiet(),
      quiet(),
    ]);
    const { user, id } = await owner(deps);
    await testCustomerTurn(deps, telegram(id, "My card ends 1234"));

    timer.advance(91 * day);
    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "email",
      externalId: "attacker@example.com",
      proof: { rule: "dmarc", pass: false, policy: "none" },
      message: "Hi",
    });
    await testCustomerTurn(deps, telegram(id, "I'm attacker@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
    expect((await identityOf(deps, user.id, "7")).lapsedAt).not.toBeNull();
  });

  it("can't receive a code as another sender's way in", async () => {
    const { deps, sent, timer } = await instance([
      quiet(),
      verifies({ channel: "telegram", externalId: "7" }),
      quiet(),
    ]);
    const { id } = await owner(deps);
    await testCustomerTurn(deps, telegram(id, "Hi"));

    timer.advance(91 * day);
    await testCustomerTurn(deps, {
      representativeId: id,
      channel: "chat",
      externalId: "session-1",
      proof: toRecord,
      message: "I'm that Telegram account",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });
});

describe("a Channel with no rule", () => {
  it("sends nothing, and says nothing can be proved here", async () => {
    const { deps, sent, fake } = await instance([
      verifies({ channel: "sms", externalId: "+15550001" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "sms", externalId: "+15550001" });

    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
    expect(answerIn(fake.calls[1])).not.toContain("on its way");
    expect(answerIn(fake.calls[1])).toContain("can't be proved");
  });
});

describe("a signed link on email", () => {
  const email = (id: string, message: string, pass = false): TestCustomerTurn => ({
    representativeId: id,
    channel: "email",
    externalId: "a@example.com",
    proof: { rule: "dmarc", pass, policy: pass ? "reject" : "none" },
    message,
  });
  const linkUrl = (token: string) => `http://localhost/api/chat/representative/verify/${token}`;
  const post = (deps: TestDeps, token: string) =>
    createTestChat({ deps }).fetch(new Request(linkUrl(token), { method: "POST" }));

  async function linkSent(extra: Round[] = []) {
    const started = await instance([verifies(), quiet(), ...extra]);
    const account = await owner(started.deps);
    await testCustomerTurn(started.deps, email(account.id, "Hi"));
    await expect.poll(() => started.sent.length).toBe(1);
    expect(started.sent[0]).toMatchObject({ externalId: "a@example.com", kind: "link" });
    return { ...started, ...account, token: started.sent[0]!.secret };
  }

  const verifiedAt = async (deps: TestDeps, userId: string) =>
    (await identityOf(deps, userId, "a@example.com")).verifiedContactAt;

  it("goes only to the address the message came from, whatever the Model claims", async () => {
    const { deps, sent } = await instance([
      verifies({ channel: "email", externalId: "other@example.com" }),
      quiet(),
    ]);
    const { id, rpc } = await owner(deps);
    await rpc.representative.customerCreate({ channel: "email", externalId: "other@example.com" });

    await testCustomerTurn(deps, email(id, "I'm other"));
    await expect.poll(() => sent.length).toBe(1);

    expect(sent[0]!.externalId).toBe("a@example.com");
  });

  it("isn't sent when an enforcing DMARC pass already vouches", async () => {
    const { deps, sent } = await instance([verifies(), quiet()]);
    const { id } = await owner(deps);

    await testCustomerTurn(deps, email(id, "Hi", true));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });

  it("verifies only when confirmed: a mail scanner opening it proves nothing", async () => {
    const { deps, user, token } = await linkSent();

    const opened = await createTestChat({ deps }).fetch(new Request(linkUrl(token)));
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("<form");
    expect(await verifiedAt(deps, user.id)).toBeNull();

    expect((await post(deps, token)).status).toBe(200);
    expect(await verifiedAt(deps, user.id)).not.toBeNull();
  });

  it("refuses another spelling of a link's signature, and the link itself still works", async () => {
    const { deps, user, token } = await linkSent();
    const [id, signature] = token.split(".") as [string, string];

    for (const spelling of [otherSpelling(signature), `${signature}!`, `${signature}=`]) {
      expect((await post(deps, `${id}.${spelling}`)).status).toBe(410);
    }
    expect(await verifiedAt(deps, user.id)).toBeNull();

    expect((await post(deps, token)).status).toBe(200);
  });

  it("verifies once", async () => {
    const { deps, token } = await linkSent();

    expect((await post(deps, token)).status).toBe(200);
    expect((await post(deps, token)).status).toBe(410);
  });

  it("makes the address's next mail verified, for an hour", async () => {
    const { deps, user, id, token, timer } = await linkSent([quiet(), quiet()]);
    await post(deps, token);

    await testCustomerTurn(deps, email(id, "Now then"));
    timer.advance(proofLastsMs);
    await testCustomerTurn(deps, email(id, "Later"));

    const messages = (await messagesOf(deps, user.id, "a@example.com")).filter(
      ({ author }) => author === "customer",
    );
    expect(messages.at(-2)).toMatchObject({ text: "Now then", verified: true });
    expect(messages.at(-1)).toMatchObject({ text: "Later", verified: false });
  });

  it("doesn't count mail that fails an enforcing domain's DMARC, even in the hour after a link", async () => {
    const { deps, user, id, token } = await linkSent([quiet()]);
    await post(deps, token);

    await testCustomerTurn(deps, {
      ...email(id, "A forgery"),
      proof: { rule: "dmarc", pass: false, policy: "reject" },
    });

    const messages = (await messagesOf(deps, user.id, "a@example.com")).filter(
      ({ author }) => author === "customer",
    );
    expect(messages.at(-1)).toMatchObject({ text: "A forgery", verified: false });
  });

  it("refuses a forged link", async () => {
    const { deps, user, token } = await linkSent();
    const [id, signature] = token.split(".");
    const flipped = signature!.startsWith("A")
      ? `B${signature!.slice(1)}`
      : `A${signature!.slice(1)}`;

    for (const forged of [
      `${id}.${flipped}`,
      `${id}.`,
      id!,
      `not-a-uuid.${signature}`,
      `${uuidv7()}.${signature}`,
      `${id}.${signature}.extra`,
    ]) {
      expect((await post(deps, forged)).status).toBe(410);
    }
    expect(await verifiedAt(deps, user.id)).toBeNull();
  });

  it("refuses an expired link, on a fake clock", async () => {
    const { deps, user, token, timer } = await linkSent();

    timer.advance(60 * minute);

    expect((await post(deps, token)).status).toBe(410);
    expect(await verifiedAt(deps, user.id)).toBeNull();
  });

  it("refuses a link once a newer one has gone", async () => {
    const { deps, sent, id, token } = await linkSent([verifies(), quiet()]);
    await testCustomerTurn(deps, email(id, "Again?"));
    await expect.poll(() => sent.length).toBe(2);

    expect((await post(deps, token)).status).toBe(410);
    expect((await post(deps, sent[1]!.secret)).status).toBe(200);
  });

  it("refuses a blocked Customer's link", async () => {
    const { deps, user, token, rpc } = await linkSent();
    const [customer] = await customersOf(deps, user.id);
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });

    expect((await post(deps, token)).status).toBe(410);
    expect(await verifiedAt(deps, user.id)).toBeNull();
  });
});
