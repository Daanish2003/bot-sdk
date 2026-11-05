import type { AnyTextAdapter } from "@tanstack/ai";
import { noCustomerChannel } from "../src/server/customer-proof";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  claimPastDeliveries,
  fakeChannel,
  promoteAutoTopic,
  autoSource,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeThread } from "../src/server/db/schema";
import { threadIdleMs } from "../src/server/idle";
import { takeoverNote } from "../src/server/takeover";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * An owner takes over a thread and hands it back (ticket #1253): through the owner's API, with the
 * Customer on a fake Channel and a fake Model on real Postgres. The clock is the test's, and it
 * claims jobs by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;
const number = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );

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
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 1_000,
    jobs: () => made!.parts.jobs,
  });
  runners.push(jobs);
  const deps = createTestSdk({
    jobs,
    clock: timer.clock.now,
    features: [representative()],
    adapterFor: () => adapter,
    memory: false,
  });
  made = deps;
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

  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  await promoteAutoTopic(id);
  const running: Array<Promise<void>> = [];
  const claim = async () => {
    const claimed = await claimPastDeliveries(jobs, timer.clock.now(), { respectRunAfter: true });
    if (!claimed) return false;
    running.push(jobs.runClaimed(claimed, {}));
    return true;
  };
  const attemptsEnd = () => Promise.all(running);
  const thread = async () => {
    const [summary] = await rpc.representative.threadList({ id });
    return rpc.representative.threadGet({ id: summary!.id });
  };
  return {
    fake,
    entered,
    timer,
    deps,
    rpc,
    claim,
    attemptsEnd,
    thread,
    /** Whether a job was due, having run it to its end. */
    runDue: async () => {
      const claimed = await claim();
      await attemptsEnd();
      return claimed;
    },
    /** Moves the clock on, having run every job that came due, whenever each was due. */
    pass: async (ms: number) => {
      timer.advance(ms);
      while (await claim()) await attemptsEnd();
    },
    /** The Customer's message; its job is null when no Turn follows. */
    send: async (
      message: string,
      sender: { proof?: { rule: "sameIdentity" }; externalId?: string } = {},
    ) =>
      (await receiveCustomerMessage(
        { ...feature.context, channel: noCustomerChannel },
        {
          representativeId: id,
          channel: fakeChannel,
          externalId: number,
          message,
          ...sender,
        },
      ))!,
    takeOver: async () => rpc.representative.threadTakeOver({ id: (await thread()).id }),
    handBack: async () => rpc.representative.threadHandBack({ id: (await thread()).id }),
    say: async (text: string) => rpc.representative.threadSend({ id: (await thread()).id, text }),
  };
}

const prompt = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

describe("taking over during a Turn", () => {
  it("aborts the Turn, and its unsent reply reaches neither the Customer nor the thread", async () => {
    const held = gate();
    const { entered, timer, claim, attemptsEnd, send, takeOver, thread, deps } = await serving(
      [replies("Too late.")],
      held.opened,
    );
    const { jobId } = await send("Hello");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    await takeOver();
    held.open();
    await attemptsEnd();

    expect((await deps.runner.status(jobId!))?.status).toBe("cancelled");
    const { messages } = await thread();
    expect(messages.map((message) => message.text)).toEqual(["Hello", takeoverNote]);
  });

  it("still drops that reply when the owner has already handed back", async () => {
    const held = gate();
    const { entered, timer, claim, attemptsEnd, send, takeOver, say, handBack, thread } =
      await serving([replies("Too late.")], held.opened);
    await send("Hello");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    await takeOver();
    await say("I'll sort this out.");
    await handBack();
    held.open();
    await attemptsEnd();

    const { messages } = await thread();
    expect(messages.map((message) => message.text)).not.toContain("Too late.");
  });

  it("cancels a Turn still waiting to start, so no model call follows", async () => {
    const { fake, timer, runDue, send, takeOver } = await serving([quiet()]);
    await send("Hello");
    await takeOver();

    timer.advance(10_000);
    expect(await runDue()).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a thread the owner holds", () => {
  it("shows the owner as holder, and its label follows who is owed a reply", async () => {
    const { send, takeOver, say, thread, rpc } = await serving([]);
    await send("Hello");
    await takeOver();

    // The note answers nothing: the Customer is still owed a reply, by the owner.
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "owner" });
    await say("Hi, this is the owner.");
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "customer" });
    await send("Thanks");
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "owner" });

    const { representativeId } = await thread();
    const [listed] = await rpc.representative.threadList({ id: representativeId });
    expect(listed).toMatchObject({ holder: "owner", waitingOn: "owner" });
  });

  it("waits on the Customer after a takeover of a thread already answered", async () => {
    const { timer, runDue, send, takeOver, thread } = await serving([replies("Hello!"), quiet()]);
    await send("Hi");
    timer.advance(500);
    await runDue();

    await takeOver();
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "customer" });
  });

  it("keeps the Customer's messages and makes no model call", async () => {
    const { fake, timer, runDue, send, takeOver, thread } = await serving([]);
    await send("Hello");
    await takeOver();

    expect((await send("Are you there?")).jobId).toBeNull();
    await send("Hello again?");
    timer.advance(10_000);
    expect(await runDue()).toBe(false);

    expect(fake.calls).toHaveLength(0);
    const { messages, messageCount } = await thread();
    expect(messages.map((message) => message.text)).toEqual([
      "Hello",
      takeoverNote,
      "Are you there?",
      "Hello again?",
    ]);
    expect(messageCount).toBe(4);
  });

  it("sends the fixed note once per takeover, to where the Customer was last heard, with no model call", async () => {
    const { fake, send, takeOver, handBack, thread } = await serving([]);
    await send("Hello");
    await takeOver();
    await takeOver();

    const notes = async () =>
      (await thread()).messages.filter((message) => message.text === takeoverNote);
    expect(await notes()).toEqual([
      expect.objectContaining({ author: "note", channel: fakeChannel, externalId: number }),
    ]);

    await handBack();
    await takeOver();
    expect(await notes()).toHaveLength(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the owner's messages straight to where the Customer was last heard", async () => {
    const { send, takeOver, say, thread } = await serving([]);
    await send("Hello");
    await takeOver();

    await say("Hi, this is the owner.");

    expect((await thread()).messages.at(-1)).toMatchObject({
      author: "owner",
      text: "Hi, this is the owner.",
      channel: fakeChannel,
      externalId: number,
    });
  });

  it("refuses the owner's message unless the owner holds the thread", async () => {
    const { send, say, takeOver, handBack, thread } = await serving([]);
    await send("Hello");

    const notHeld = { data: { code: "error.threadNotHeld" } };
    await expect(say("Hi")).rejects.toMatchObject(notHeld);
    await takeOver();
    await handBack();
    await expect(say("Hi")).rejects.toMatchObject(notHeld);
    expect((await thread()).messages.map((message) => message.author)).not.toContain("owner");
  });

  it("sends a blocked Customer no note and none of the owner's messages", async () => {
    const { send, takeOver, say, thread, rpc } = await serving([]);
    await send("Hello");
    const { customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await takeOver();
    await expect(say("Hi")).rejects.toMatchObject({ data: { code: "error.customerBlocked" } });

    const { holder, messages } = await thread();
    expect(holder).toBe("owner");
    expect(messages.map((message) => message.text)).toEqual(["Hello"]);
  });

  it("isn't another owner's: every action says not found", async () => {
    const { send, thread, deps } = await serving([]);
    await send("Hello");
    const { id } = await thread();
    const stranger = chatRpc({ user: await insertUser(), deps });

    const notFound = { data: { code: "error.threadNotFound" } };
    await expect(stranger.representative.threadTakeOver({ id })).rejects.toMatchObject(notFound);
    await expect(stranger.representative.threadHandBack({ id })).rejects.toMatchObject(notFound);
    await expect(stranger.representative.threadSend({ id, text: "Hi" })).rejects.toMatchObject(
      notFound,
    );
    expect((await thread()).holder).toBe("representative");
  });
});

describe("nothing but the owner's Hand back", () => {
  it("gives a held thread back: not messages, and not time", async () => {
    const { fake, timer, runDue, send, takeOver, thread } = await serving([]);
    await send("Hello");
    await takeOver();

    for (let hour = 0; hour < 3; hour++) {
      await send(`Message ${hour}`);
      timer.advance(60 * 60_000);
      await runDue();
    }

    expect((await thread()).holder).toBe("owner");
    expect(fake.calls).toHaveLength(0);
  });

  it("can't reopen a closed thread", async () => {
    const { pass, send, takeOver, handBack, say, thread } = await serving([
      replies("Hi."),
      quiet(),
    ]);
    await send("Hello");
    await pass(1_000); // its Turn answers, and the idle days run from there
    await pass(threadIdleMs);
    const { holder, messageCount } = await thread();
    expect(holder).toBe("closed");

    const closed = { data: { code: "error.threadClosed" } };
    await expect(takeOver()).rejects.toMatchObject(closed);
    await expect(handBack()).rejects.toMatchObject(closed);
    await expect(say("Hi")).rejects.toMatchObject(closed);
    expect(await thread()).toMatchObject({ holder: "closed", messageCount });
  });
});

describe("a thread the owner holds, over time", () => {
  it("never closes, even with no owner activity at all", async () => {
    const { pass, send, takeOver, thread } = await serving([]);
    await send("Hello");
    await takeOver();

    for (let week = 0; week < 8; week++) {
      await pass(threadIdleMs);
      expect((await thread()).holder).toBe("owner");
    }
  });

  it("keeps a Customer's message on it, however long it has been held, and no new thread opens", async () => {
    const { pass, send, takeOver, thread, rpc, fake } = await serving([]);
    await send("Hello");
    await takeOver();
    const { id, representativeId } = await thread();

    await pass(threadIdleMs * 3);
    await send("Anyone there?");
    await pass(threadIdleMs * 3);

    const threads = await rpc.representative.threadList({ id: representativeId });
    expect(threads.map((listed) => [listed.id, listed.holder])).toEqual([[id, "owner"]]);
    expect((await thread()).messages.at(-1)?.text).toBe("Anyone there?");
    expect(fake.calls).toHaveLength(0);
  });

  it("closes 7 days after Hand back, and not before, however long the hold was", async () => {
    const { pass, send, takeOver, say, handBack, thread } = await serving([]);
    await send("Hello");
    await takeOver();
    await say("On it.");

    // A check runs during the hold, so the next is due less than 7 days after Hand back.
    await pass(threadIdleMs * 3);
    await pass(day);
    await handBack();
    await pass(0);
    expect((await thread()).holder).toBe("representative");

    await pass(threadIdleMs - 1);
    expect((await thread()).holder).toBe("representative");

    await pass(1);
    expect((await thread()).holder).toBe("closed");
  });
});

describe("after handing back", () => {
  it("the next Turn's prompt holds the owner's words, marked as such, and the Customer's messages from the takeover", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack, thread } = await serving([quiet()]);
    await send("Hello");
    await takeOver();
    await send("During the takeover");
    await say("We can refund you.");
    await handBack();
    expect((await thread()).holder).toBe("representative");

    await send("Thanks, and the receipt?");
    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(fake.calls).toHaveLength(1);
    const text = prompt(fake.calls[0]);
    expect(text).toMatch(/owner of this business[^"]*We can refund you\./);
    expect(text).toContain("During the takeover");
    expect(text).toMatch(/We can refund you\..*Thanks, and the receipt\?/);
  });

  it("a Customer's message the owner left unanswered gets a Turn", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack, thread } = await serving([
      replies("Here it is."),
      quiet(),
    ]);
    await send("Hello");
    await takeOver();
    await say("Looking into it.");
    await send("One more thing");
    expect(await thread()).toMatchObject({ waitingOn: "owner" });

    await handBack();
    expect(await thread()).toMatchObject({ holder: "representative", waitingOn: "representative" });
    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(prompt(fake.calls[0])).toMatch(/Looking into it\..*One more thing/);
    expect(await thread()).toMatchObject({ waitingOn: "customer" });
  });

  it("a message whose Turn was aborted gets a Turn when the owner said nothing", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, send, takeOver, handBack, runDue } =
      await serving([replies("Too late."), quiet()], held.opened);
    await send("Hello");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await takeOver();
    held.open();
    await attemptsEnd();

    await handBack();
    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls.at(-1))).toContain("Hello");
  });

  it("a message that waited through the Turn before the takeover still gets one", async () => {
    const held = gate();
    const { fake, entered, timer, claim, attemptsEnd, send, takeOver, handBack, runDue, thread } =
      await serving([replies("Hello!"), quiet(), quiet()], held.opened);
    await send("First");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await send("Second");
    held.open();
    await attemptsEnd();

    await takeOver();
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "owner" });
    await handBack();
    timer.advance(500);
    expect(await runDue()).toBe(true);

    expect(prompt(fake.calls.at(-1))).toMatch(/Hello!.*Second/);
  });

  it("what an aborted Turn was answering gets a Turn, though another sender's message waited behind it", async () => {
    const held = gate();
    const { entered, timer, claim, attemptsEnd, send, takeOver, handBack, runDue, thread, rpc } =
      await serving([replies("Too late"), quiet(), quiet()], held.opened);
    await send("From the first address", { proof: { rule: "sameIdentity" } });
    const { customer } = await thread();
    await rpc.representative.customerAddIdentity({
      id: customer.id,
      channel: fakeChannel,
      externalId: "+15550002",
    });
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);
    await send("From the second address", { externalId: "+15550002" });

    await takeOver();
    held.open();
    await attemptsEnd();
    await handBack();
    timer.advance(500);
    expect(await runDue()).toBe(true);

    const prompted = prompt(entered.at(-1) as { messages: unknown });
    expect(entered).toHaveLength(2);
    expect(prompted).toContain("From the first address");
    expect(prompted).not.toContain("From the second address");
  });

  it("leaves a batch a Turn ended on alone, when the next Turn hadn't begun", async () => {
    const { timer, send, takeOver, runDue, thread } = await serving([quiet()]);
    await send("Nothing to say to this");
    timer.advance(500);
    expect(await runDue()).toBe(true);
    await send("Next");

    await takeOver();

    const { id } = await thread();
    const [row] = await getTestDb()
      .select({ waitingFrom: representativeThread.waitingFrom })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    // "Next", after code's hand-off for the Turn that said nothing.
    expect(row?.waitingFrom).toBe(3);
  });

  it("an aborted Turn gives back only its own batch, not what was settled before it", async () => {
    const held = gate();
    const { entered, timer, claim, attemptsEnd, send, takeOver, thread, rpc } = await serving(
      [quiet()],
      held.opened,
    );
    await send("Kept");
    const { customer, id } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
    await send("Kept during the block");
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: false });
    await send("Now");
    timer.advance(500);
    await claim();
    await expect.poll(() => entered.length, poll).toBe(1);

    await takeOver();
    held.open();
    await attemptsEnd();

    const [row] = await getTestDb()
      .select({ waitingFrom: representativeThread.waitingFrom })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    expect(row?.waitingFrom).toBe(3);
  });

  it("what was kept while the Customer was blocked gets no Turn, even after an unblock", async () => {
    const { fake, timer, runDue, send, takeOver, handBack, thread, rpc } = await serving([quiet()]);
    await send("Hello");
    timer.advance(500);
    await runDue();
    const { customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
    await send("Kept");
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: false });

    await takeOver();
    await handBack();

    timer.advance(10_000);
    expect(await runDue()).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("the owner's word to one address leaves another address's message waiting", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack, thread, rpc } = await serving([
      quiet(),
    ]);
    await send("Hello", { proof: { rule: "sameIdentity" } });
    const { customer } = await thread();
    await rpc.representative.customerAddIdentity({
      id: customer.id,
      channel: fakeChannel,
      externalId: "+15550002",
    });
    await takeOver();
    await send("It's me on another number", { externalId: "+15550002" });
    await say("Hello, this is the owner.");
    expect(await thread()).toMatchObject({ holder: "owner", waitingOn: "owner" });

    await handBack();
    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(prompt(fake.calls[0])).toContain("It's me on another number");
    expect(prompt(fake.calls[0])).not.toContain("Hello, this is the owner.");
  });

  it("no Turn runs when the owner answered last", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack, thread } = await serving([]);
    await send("Hello");
    await takeOver();
    await say("All done.");
    await handBack();

    timer.advance(10_000);
    expect(await runDue()).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(await thread()).toMatchObject({ holder: "representative", waitingOn: "customer" });
  });

  it("a blocked Customer's thread goes back with no Turn", async () => {
    const { fake, timer, runDue, send, takeOver, handBack, thread, rpc } = await serving([]);
    await send("Hello");
    await takeOver();
    const { customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await handBack();

    timer.advance(10_000);
    expect(await runDue()).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("handing back twice queues one Turn, and a takeover can follow", async () => {
    const { fake, timer, runDue, send, takeOver, handBack, thread } = await serving([quiet()]);
    await send("Hello");
    await takeOver();
    await handBack();
    await handBack();

    timer.advance(500);
    expect(await runDue()).toBe(true);
    expect(await runDue()).toBe(false);
    expect(fake.calls).toHaveLength(1);
    await takeOver();
    expect((await thread()).holder).toBe("owner");
  });
});

describe("what the owner said, in a Turn for a sender who isn't verified", () => {
  it("is read when it went to that same unverified address", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack } = await serving([quiet()]);
    await send("Hello");
    await takeOver();
    await say("Your order is on its way.");
    await handBack();

    await send("Thanks");
    timer.advance(500);
    await runDue();

    expect(prompt(fake.calls[0])).toContain("Your order is on its way.");
  });

  it("isn't read when it went to a verified sender at that address", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack } = await serving([quiet()]);
    await send("Hello", { proof: { rule: "sameIdentity" } });
    await takeOver();
    await say("Your balance is 400.");
    await handBack();

    // No proof on this message, so it may be anyone at that number.
    await send("What's my balance?");
    timer.advance(500);
    await runDue();

    expect(prompt(fake.calls[0])).toContain("What's my balance?");
    expect(prompt(fake.calls[0])).not.toContain("Your balance is 400.");
  });

  it("isn't read when that address has been verified, though a message kept during a block wasn't", async () => {
    const { fake, timer, runDue, send, takeOver, say, handBack, thread, rpc } = await serving([
      quiet(),
    ]);
    const proof = { rule: "sameIdentity" } as const;
    await send("Hello", { proof });
    const { customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
    await send("Kept", { proof });
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: false });
    await takeOver();
    await say("Your balance is 400.");
    await handBack();

    await send("What's my balance?");
    timer.advance(500);
    await runDue();

    expect(prompt(fake.calls[0])).not.toContain("Your balance is 400.");
  });
});
