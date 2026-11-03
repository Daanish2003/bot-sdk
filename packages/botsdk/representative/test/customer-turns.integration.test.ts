import type { AnyTextAdapter } from "@tanstack/ai";
import { eq, inArray } from "drizzle-orm";
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
import { startTestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, runError, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeThread } from "../src/server/db/schema";

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
