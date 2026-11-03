import type { AnyTextAdapter } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import {
  claimJob,
  inProcessRunner,
  type JobRunner,
  reapStaleJobs,
} from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { startTestCustomerTurn, type TestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, runError, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { threadPromptLimit } from "../src/server/customers";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";

/*
 * One Turn at a time on a thread, with quick messages batched (ticket #1250): from a fake Channel,
 * through the test Customer entry point, with a fake Model on real Postgres. The clock is the test's,
 * and it claims jobs by hand, each only once it is due at that clock's time.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const leaseLapse = 61_000;
const externalId = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) => round(toolCall({ name: "reply", input: { text } }));

type Sender = Pick<TestCustomerTurn, "channel" | "externalId" | "proof">;
const proven: Sender = { channel: "telegram", externalId: "7", proof: { rule: "sameIdentity" } };
const unproven: Sender = { channel: "sms", externalId: "+15550001" };
const otherUnproven: Sender = { channel: "sms", externalId: "+15550002" };

/** A gate a test opens, which opens by itself when the test ends. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  onTestFinished(() => open());
  return { opened, open };
}

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

// The test claims jobs by hand: none another test left behind may be claimed first.
beforeEach(async () => {
  await getTestDb()
    .update(job)
    .set({ status: "cancelled" })
    .where(inArray(job.status, ["queued", "running"]));
});

/** A Representative serving a first Release on a clock the test moves, with its jobs run by hand. */
async function serving(rounds: Round[], held?: Promise<void>) {
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
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 1_000,
    jobs: () => deps!.parts.jobs,
  });
  runners.push(jobs);
  deps = createTestSdk({
    jobs,
    clock: timer.clock.now,
    features: [representative()],
    adapterFor: () => adapter,
    memory: false,
  });
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

  const running: Array<Promise<void>> = [];
  /** Claims the next job due, or any queued one with `overdue`, and starts its attempt: whether it could. */
  const claim = async ({ overdue = false } = {}) => {
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: !overdue });
    if (!claimed) return false;
    running.push(jobs.runClaimed(claimed, {}));
    return true;
  };
  return {
    fake,
    entered,
    deps,
    timer,
    claim,
    /** Every attempt started so far has ended. */
    attemptsEnd: () => Promise.all(running),
    /** Whether a job was due, having run it to its end. */
    runDue: async () => {
      const claimed = await claim();
      await Promise.all(running);
      return claimed;
    },
    send: (message: string, from = externalId) =>
      startTestCustomerTurn(deps!, { representativeId: id, externalId: from, message }),
    say: (message: string, sender: Sender) =>
      startTestCustomerTurn(deps!, { representativeId: id, ...sender, message }),
    rpc,
    /** Puts another identity on the thread's Customer, as the owner's merge will (#1257). */
    addIdentity: async ({ channel, externalId }: Sender) => {
      const [thread] = await getTestDb()
        .select({ customerId: representativeThread.customerId })
        .from(representativeThread)
        .where(eq(representativeThread.representativeId, id));
      await getTestDb().insert(representativeCustomerIdentity).values({
        id: uuidv7(),
        userId: user.id,
        customerId: thread!.customerId,
        channel: channel!,
        externalId: externalId!,
      });
    },
    /** What this Representative sent, oldest first, and where each went. */
    sent: () =>
      getTestDb()
        .select({
          text: representativeThreadMessage.text,
          channel: representativeThreadMessage.channel,
          externalId: representativeThreadMessage.externalId,
          verified: representativeThreadMessage.verified,
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
        )
        .orderBy(representativeThreadMessage.position),
    /** The lease goes and the attempt hears, as a crashed process's replacement would find it. */
    leaseLost: async () => {
      timer.advance(leaseLapse);
      await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps!.parts.jobs);
      timer.tick();
    },
    threadRows: () =>
      getTestDb()
        .select()
        .from(representativeThread)
        .where(eq(representativeThread.representativeId, id)),
  };
}

const prompt = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

describe("quick messages", () => {
  it("reach the Model as one Turn, which starts once 0.5 s pass with no new message", async () => {
    const { fake, timer, runDue, send } = await serving([quiet()]);

    await send("One");
    timer.advance(300);
    await send("Two");
    timer.advance(300);
    // 0.5 s after the first, which the second moved on.
    expect(await runDue()).toBe(false);
    timer.advance(199);
    expect(await runDue()).toBe(false);
    timer.advance(1);
    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(1);
    expect(prompt(fake.calls[0])).toMatch(/One.*Two/);
    expect(await runDue()).toBe(false);
  });

  it("can't hold a Turn past 2.5 s after the first, however long they go on", async () => {
    const { fake, timer, runDue, send } = await serving([quiet()]);

    await send("Message 0");
    for (let at = 400; at <= 2_400; at += 400) {
      timer.advance(400);
      await send(`Message ${at}`);
      expect(await runDue()).toBe(false);
    }
    timer.advance(99);
    expect(await runDue()).toBe(false);
    timer.advance(1);
    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(1);
    expect(prompt(fake.calls[0])).toContain("Message 2400");
  });
});

describe("a message that arrives during a Turn", () => {
  it("isn't in that Turn's prompt, starts no second Turn beside it, and a next Turn answers it", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, runDue, send } = await serving(
      [quiet(), replies("Answered."), quiet()],
      held.opened,
    );
    await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    await send("Second");
    timer.advance(10_000);
    expect(await claim()).toBe(false);
    expect(entered).toHaveLength(1);

    held.open();
    await attemptsEnd();
    expect(prompt(fake.calls[0])).not.toContain("Second");

    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[1])).toMatch(/First.*Second/);
    expect(await runDue()).toBe(false);
  });

  it("is still answered when that Turn fails", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, runDue, send, deps } = await serving(
      [round(runError("The Provider is down")), quiet()],
      held.opened,
    );
    const { jobId } = await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await send("Second");
    timer.advance(10_000);
    held.open();
    await attemptsEnd();
    expect((await deps.runner.status(jobId))?.status).toBe("failed");

    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(2);
    expect(prompt(fake.calls[1])).toContain("Second");
  });
});

describe("a message that waited through a Turn", () => {
  it("ends the next Turn's prompt, after the reply it came before", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, runDue, send } = await serving(
      [replies("Hello!"), quiet(), quiet()],
      held.opened,
    );
    await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await send("What's the price?");
    held.open();
    await attemptsEnd();

    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(prompt(fake.calls.at(-1))).toMatch(/First.*Hello!.*What's the price\?/);
  });
});

describe("two threads", () => {
  it("run Turns at the same time", async () => {
    const held = gate();
    const { entered, timer, claim, send } = await serving([quiet(), quiet()], held.opened);

    await send("From one", "+1");
    await send("From another", "+2");
    timer.advance(500);
    await claim();
    await claim();

    await expect.poll(() => entered.length, poll).toBe(2);
  });
});

describe("quick messages from more than one sender", () => {
  it("never read a verified sender's messages to an unverified one", async () => {
    const { fake, timer, runDue, say, addIdentity, sent } = await serving([
      replies("Your balance is 40."),
      quiet(),
      replies("Who is this?"),
      quiet(),
    ]);
    await say("My card ends 1234", proven);
    await addIdentity(unproven);
    await say("Spoofed: remind me", unproven);

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toContain("My card ends 1234");
    expect(prompt(fake.calls[0])).not.toContain("Spoofed: remind me");
    expect(fake.calls).toHaveLength(2);

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[2])).toContain("Spoofed: remind me");
    expect(prompt(fake.calls[2])).not.toContain("My card ends 1234");
    expect(prompt(fake.calls[2])).not.toContain("Your balance is 40.");

    expect(await sent()).toMatchObject([
      { text: "Your balance is 40.", channel: "telegram", verified: true },
      { text: "Who is this?", channel: "sms", verified: false },
    ]);
  });

  it("don't verify an unverified sender who wrote first", async () => {
    const { fake, timer, runDue, say, addIdentity, sent } = await serving([
      replies("Who is this?"),
      quiet(),
      replies("Hello again."),
      quiet(),
    ]);
    await say("Spoofed: remind me", unproven);
    await addIdentity(proven);
    await say("My card ends 1234", proven);

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toContain("Spoofed: remind me");
    expect(prompt(fake.calls[0])).not.toContain("My card ends 1234");

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(await sent()).toMatchObject([
      { text: "Who is this?", channel: "sms", verified: false },
      { text: "Hello again.", channel: "telegram", verified: true },
    ]);
  });

  it("answer each unverified sender in turn, with only that sender's messages", async () => {
    const { fake, timer, runDue, say, addIdentity, sent } = await serving([
      replies("To the first"),
      quiet(),
      replies("To the second"),
      quiet(),
      replies("To the first again"),
      quiet(),
    ]);
    await say("From the first", unproven);
    await addIdentity(otherUnproven);
    await say("From the second", otherUnproven);
    await say("The first, again", unproven);

    for (let turn = 0; turn < 3; turn++) {
      timer.advance(500);
      expect(await runDue()).toBe(true);
    }

    expect(prompt(fake.calls[0])).toContain("From the first");
    expect(prompt(fake.calls[0])).not.toContain("From the second");
    expect(prompt(fake.calls[2])).toContain("From the second");
    expect(prompt(fake.calls[2])).not.toContain("From the first");
    expect(prompt(fake.calls[2])).not.toContain("To the first");
    expect(prompt(fake.calls[4])).toMatch(/From the first.*The first, again/);
    expect(prompt(fake.calls[4])).not.toContain("From the second");
    expect(prompt(fake.calls[4])).not.toContain("To the second");
    expect((await sent()).map(({ text, externalId }) => [text, externalId])).toEqual([
      ["To the first", unproven.externalId],
      ["To the second", otherUnproven.externalId],
      ["To the first again", unproven.externalId],
    ]);
    expect(await runDue()).toBe(false);
  });
});

describe("quick messages over what a Turn reads", () => {
  it("wait for the next Turn when they would pass its characters", async () => {
    const { fake, timer, runDue, send } = await serving([quiet(), quiet()]);
    for (const name of ["First", "Second", "Third", "Fourth"]) {
      await send(`${name}:${"x".repeat(59_000)}`);
    }

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toMatch(/First:.*Second:.*Third:/);
    expect(prompt(fake.calls[0])).not.toContain("Fourth:");

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[1])).toContain("Fourth:");
    expect(fake.calls).toHaveLength(2);
    expect(await runDue()).toBe(false);
  });

  it("wait for the next Turn when they would pass its messages", async () => {
    const { fake, timer, runDue, send } = await serving([quiet(), quiet()]);
    for (let at = 0; at <= threadPromptLimit; at++) await send(`Message ${at}.`);

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toContain("Message 0.");
    expect(prompt(fake.calls[0])).toContain(`Message ${threadPromptLimit - 1}.`);
    expect(prompt(fake.calls[0])).not.toContain(`Message ${threadPromptLimit}.`);

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[1])).toContain(`Message ${threadPromptLimit}.`);
  });
});

describe("a Turn with nothing left to answer", () => {
  it("runs no Model for a Customer blocked as the message arrived", async () => {
    const { fake, timer, runDue, send, threadRows } = await serving([quiet()]);
    await send("Crossed with the block");
    // Where a block and an arriving message leave it when the message reads the Customer first.
    await getTestDb()
      .update(representativeCustomer)
      .set({ blockedAt: timer.clock.now() })
      .where(eq(representativeCustomer.id, (await threadRows())[0]!.customerId));

    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(0);
    expect((await threadRows())[0]).toMatchObject({ turnId: null, waitingFrom: null });
  });

  it.each(["owner", "closed"] as const)("runs no Model on a thread that is %s", async (state) => {
    const { fake, timer, runDue, send, threadRows } = await serving([quiet()]);
    await send("Hello?");
    await getTestDb()
      .update(representativeThread)
      .set({ state })
      .where(eq(representativeThread.id, (await threadRows())[0]!.id));

    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(0);
    expect((await threadRows())[0]).toMatchObject({ turnId: null, waitingFrom: null });
  });
});

describe("a blocked Customer", () => {
  const customerOf = async (threadRows: () => Promise<{ customerId: string }[]>) =>
    (await threadRows())[0]!.customerId;

  it("gets no Turn for a message still waiting, and the next one after an unblock is answered", async () => {
    const { fake, timer, runDue, send, rpc, threadRows, sent } = await serving([
      replies("Welcome back."),
      quiet(),
    ]);
    await send("Waiting");
    const id = await customerOf(threadRows);
    await rpc.representative.customerSetBlocked({ id, blocked: true });

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect((await threadRows())[0]).toMatchObject({ turnId: null, waitingFrom: null });

    await rpc.representative.customerSetBlocked({ id, blocked: false });
    timer.advance(10_000);
    expect(await runDue()).toBe(false);

    await send("Unblocked now");
    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toContain("Unblocked now");
    expect(await sent()).toMatchObject([{ text: "Welcome back." }]);
  });

  it("gets nothing from a Turn already running, nor a Turn for what came during it", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, runDue, send, rpc, threadRows, sent } =
      await serving([replies("Too late"), quiet()], held.opened);
    await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await send("Second");
    await rpc.representative.customerSetBlocked({
      id: await customerOf(threadRows),
      blocked: true,
    });

    held.open();
    await attemptsEnd();
    expect(await sent()).toEqual([]);

    timer.advance(10_000);
    expect(await runDue()).toBe(false);
    expect(fake.calls.map((call) => prompt(call)).join()).not.toContain("Second");
    expect((await threadRows())[0]).toMatchObject({ turnId: null, waitingFrom: null });
  });
});

describe("a crash replay of a Turn", () => {
  it("sees the messages it started with, and a next Turn answers what came since", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, runDue, send, leaseLost } = await serving(
      [quiet(), quiet(), quiet()],
      held.opened,
    );
    await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    await send("Second");
    await leaseLost();
    held.open();
    await attemptsEnd();
    expect(await claim({ overdue: true })).toBe(true);
    await attemptsEnd();

    expect(entered.length).toBe(2);
    expect(prompt(entered[1] as { messages: unknown })).toContain("First");
    expect(prompt(entered[1] as { messages: unknown })).not.toContain("Second");

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls.at(-1))).toMatch(/First.*Second/);
  });

  it("answers the same sender, in the state it had at the start", async () => {
    const held = gate();
    const { entered, timer, claim, attemptsEnd, say, leaseLost, sent } = await serving(
      [quiet(), replies("Who is this?"), quiet(), quiet()],
      held.opened,
    );
    await say("Spoofed: remind me", unproven);
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    // The identity proves itself during the Turn, which began on what it was.
    await say("Proved now", { ...unproven, proof: { rule: "sameIdentity" } });
    await leaseLost();
    held.open();
    await attemptsEnd();
    expect(await claim({ overdue: true })).toBe(true);
    await attemptsEnd();

    expect(entered.length).toBeGreaterThan(1);
    expect(prompt(entered[1] as { messages: unknown })).not.toContain("Proved now");
    expect(await sent()).toMatchObject([{ text: "Who is this?", channel: "sms", verified: false }]);
  });
});

describe("the Turn's job", () => {
  it("carries no message and no Customer: the thread holds those", async () => {
    const { send, threadRows } = await serving([]);

    const { jobId } = await send("A secret");

    const [thread] = await threadRows();
    const [row] = await getTestDb().select().from(job).where(eq(job.id, jobId));
    expect(row?.payload).toEqual({ threadId: thread!.id, turnId: thread!.turnId });
  });

  it("does nothing once its thread has passed to another Turn", async () => {
    const { fake, timer, runDue, send, threadRows } = await serving([quiet()]);
    await send("Hi");
    const [thread] = await threadRows();
    const other = uuidv7();
    await getTestDb()
      .update(representativeThread)
      .set({ turnId: other })
      .where(eq(representativeThread.id, thread!.id));
    timer.advance(500);

    expect(await runDue()).toBe(true);

    expect(fake.calls).toEqual([]);
    expect((await threadRows())[0]?.turnId).toBe(other);
  });

  it("is followed by a new Turn on the next message when something else ended it", async () => {
    const { fake, timer, runDue, send, threadRows, deps } = await serving([quiet()]);
    await send("One");
    const ended = (await threadRows())[0]!.turnId!;
    await deps.runner.cancel(ended);

    await send("Two");
    expect((await threadRows())[0]?.turnId).not.toBe(ended);
    timer.advance(500);

    expect(await runDue()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(prompt(fake.calls[0])).toMatch(/One.*Two/);
  });
});
