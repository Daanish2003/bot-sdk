import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment, job } from "@botsdk/bot/storage";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  approveDrafts,
  fakeChannel,
  promoteAutoTopic,
  autoSource,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import {
  representativeCustomerIdentity,
  representativeHandOff,
  representativeHeldMessage,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { noCustomerChannel } from "../src/server/customer-proof";
import { representativeFeature } from "../src/server/plugin";
import { handOffMessage } from "../src/server/replies";
import { takeoverNote } from "../src/server/takeover";
import { beginTurn } from "../src/server/thread-turns";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * A hand-off's result returns to its thread (ticket #1254): the Representative hands work to its
 * Bot, the Bot finishes it, and what it says for the Customer reaches them through a Turn, or the
 * owner, or neither. Fake Models and a fake Channel on real Postgres; the clock is the test's, and
 * jobs are claimed by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
/** A daytime in UTC, the business's time zone by default: the business starts nothing in quiet hours, so tests that run on a clock pin one rather than read the real hour. */
const noon = new Date("2026-11-04T12:00:00Z");
const silent = { error: () => {} };
const number = "+15550001";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const quiet = () => round();
const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );
const replies = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );

/** Relays the Bot's result, citing the Assignment the prompt names, or `cited`, with `quote`. */
const relays = (quote: string, cited?: string) => (call: TextOptions) =>
  round(
    toolCall({
      name: "reply",
      input: {
        topic: "general",
        text: "Good news: your refund is on its way.",
        kind: "answer",
        sources: [
          {
            type: "assignment",
            assignmentId:
              cited ?? /Assignment ([0-9a-f-]{36}): cite/.exec(JSON.stringify(call.messages))![1],
            quote,
          },
        ],
      },
    }),
  );

const assignmentIdIn = (call: TextOptions) =>
  /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;
const finishes = (fields: Record<string, unknown>) => (call: TextOptions) =>
  round(
    toolCall({
      name: "run_tool",
      input: { name: "finish_assignment", args: { id: assignmentIdIn(call), ...fields } },
    }),
  );
const refunded = finishes({
  status: "done",
  outcome: "Refunded.",
  for_customer: "Your refund of 20 is on its way.",
});

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

async function serving(
  representativeRounds: Rounds,
  botRounds: Rounds = [refunded, quiet],
  held?: Promise<void>,
  start = noon,
) {
  const fake = createFakeAdapter({ rounds: representativeRounds });
  const entered: unknown[] = [];
  const gated: AnyTextAdapter = {
    ...(fake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      entered.push(options);
      await held;
      yield* fake.adapter.chatStream(options);
    },
  };
  const botFake = createFakeAdapter({ rounds: botRounds });
  const timer = fakeJobClock(start);
  const proofsSent: Array<{ channel: string; externalId: string; kind: string; secret: string }> =
    [];
  let made: ReturnType<typeof createTestSdk> | undefined;
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
    features: [
      representativeFeature(
        {},
        {
          ...noCustomerChannel,
          sendProof: async (to, proof) => {
            proofsSent.push({ ...to, ...proof });
          },
        },
      ),
    ],
    adapterFor: (id) => (id === botModel ? botFake.adapter : gated),
    memory: false,
  });
  made = deps;
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "...-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model,
      tools: ["reply", "hand_to_bot", "verify_customer"],
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  await promoteAutoTopic(id);
  const thread = async () => {
    const [summary] = await rpc.representative.threadList({ id });
    return rpc.representative.threadGet({ id: summary!.id });
  };
  /** Runs the next due job to its end, the batch window passed; whether there was one. */
  const runNext = async () => {
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    if (!claimed) return false;
    await jobs.runClaimed(claimed, {});
    return true;
  };
  return {
    jobs,
    timer,
    entered,
    proofsSent,
    fake,
    botFake,
    rpc,
    thread,
    botId,
    runNext,
    /** Runs every due job, the Bot's and the Representative's, until none is left. */
    drain: async () => {
      for (let tries = 0; tries < 30; tries += 1) if (!(await runNext())) return;
      throw new Error("The jobs never ran out");
    },
    send: async (message: string, proof?: { rule: "sameIdentity" | "codeRoundTrip" }) =>
      receiveCustomerMessage(
        { ...feature.context, channel: noCustomerChannel },
        {
          representativeId: id,
          channel: fakeChannel,
          externalId: number,
          message,
          proof,
        },
      ),
  };
}

/** How many Turns the thread has had queued, running or done. */
const turnsOf = async (threadId: string) =>
  (
    await getTestDb()
      .select({ id: job.id })
      .from(job)
      .where(
        and(eq(job.name, "representative.turn"), sql`${job.payload}->>'threadId' = ${threadId}`),
      )
  ).length;

const texts = (messages: Array<{ text: string }>) => messages.map((message) => message.text);

describe("a verified Customer's result, after they moved", () => {
  const elsewhere = "+15550009";

  /** A verified Customer's Turn handed off, they have moved since, and `optedOut` has opted out. */
  async function moved(optedOut: string) {
    const world = await serving([handsOff(), quiet(), quiet()]);
    await world.send("I want a refund", { rule: "sameIdentity" });
    await world.runNext();
    const { id, customer } = await world.thread();
    await world.rpc.representative.customerAddIdentity({
      id: customer.id,
      channel: fakeChannel,
      externalId: elsewhere,
    });
    await getTestDb()
      .update(representativeThread)
      .set({ lastExternalId: elsewhere })
      .where(eq(representativeThread.id, id));
    await getTestDb()
      .update(representativeCustomerIdentity)
      .set({ optedOutAt: noon })
      .where(
        and(
          eq(representativeCustomerIdentity.customerId, customer.id),
          eq(representativeCustomerIdentity.externalId, optedOut),
        ),
      );
    await world.drain();
    return { world, id };
  }

  it("wakes a Turn though the address they handed off from has opted out: it goes where they are", async () => {
    const { id } = await moved(number);
    expect(await turnsOf(id)).toBe(2);
  });

  it("wakes none when it is the address they are at now that has opted out", async () => {
    const { id } = await moved(elsewhere);
    expect(await turnsOf(id)).toBe(1);
  });
});

describe("a takeover as a Turn tells a Bot's result", () => {
  it("leaves the draft an earlier Turn wrote for an earlier question, whose batch isn't waiting", async () => {
    const drafted = round(
      toolCall({ name: "reply", input: { text: "About your bill", kind: "small_talk" } }),
    );
    const { send, runNext, thread, rpc, timer } = await serving([drafted, handsOff(), quiet()]);
    await send("I want a refund");
    // Up to the Bot's result on the thread, with the Turn that tells it queued and not run.
    for (let tries = 0; tries < 30; tries += 1) {
      await runNext();
      if ((await thread()).messages.some((message) => message.author === "bot")) break;
    }
    const { id } = await thread();
    const [row] = await getTestDb()
      .select({ turnId: representativeThread.turnId })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    await getTestDb().transaction((tx) => beginTurn(tx, id, row!.turnId!, timer.clock.now()));

    await rpc.representative.threadTakeOver({ id });

    const held = await getTestDb()
      .select({
        text: representativeHeldMessage.text,
        resolution: representativeHeldMessage.resolution,
      })
      .from(representativeHeldMessage)
      .where(eq(representativeHeldMessage.threadId, id));
    expect(held).toEqual([{ text: "About your bill", resolution: null }]);
  });
});

describe("a hand-off's result", () => {
  it("isn't made by a Turn whose Customer the owner blocks during its Model call", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const { entered, jobs, timer, send, thread, rpc, botId } = await serving(
      [handsOff(), quiet()],
      undefined,
      held,
    );
    await send("I want a refund");
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    const attempt = jobs.runClaimed(claimed!, {});
    await vi.waitFor(() => expect(entered).toHaveLength(1), { timeout: 10_000 });
    const { customer, id } = await thread();

    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    const [turn] = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(and(eq(job.name, "representative.turn"), sql`${job.payload}->>'threadId' = ${id}`));
    expect(turn?.status).toBe("cancelled");
    const [row] = await getTestDb()
      .select({ turnId: representativeThread.turnId })
      .from(representativeThread)
      .where(eq(representativeThread.id, id));
    expect(row?.turnId).toBeNull();
    open();
    await attempt;
    expect(entered).toHaveLength(1);
    expect(
      await getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId)),
    ).toEqual([]);
  });

  it("keeps naming the Customer once the result is delivered", async () => {
    const { send, drain, thread } = await serving([handsOff(), quiet(), quiet()]);
    await send("I want a refund");

    await drain();

    const { customer } = await thread();
    const rows = await getTestDb()
      .select({
        threadId: representativeHandOff.threadId,
        customerId: representativeHandOff.customerId,
      })
      .from(representativeHandOff);
    // Delivered once: the thread is cleared, the Customer is not.
    expect(rows).toEqual([{ threadId: null, customerId: customer.id }]);
  });

  it("wakes a Turn that tells the Customer, where they were last heard", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("Good news: your refund is on its way."),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    const { messages, waitingOn } = await thread();
    expect(messages).toEqual([
      expect.objectContaining({ author: "customer", text: "I want a refund" }),
      expect.objectContaining({
        author: "bot",
        text: "Your refund of 20 is on its way.",
        channel: fakeChannel,
        externalId: number,
      }),
      expect.objectContaining({
        author: "representative",
        text: "Good news: your refund is on its way.",
        channel: fakeChannel,
        externalId: number,
      }),
    ]);
    // The Turn that told the Customer read the result.
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain(
      "Your refund of 20 is on its way.",
    );
    expect(waitingOn).toBe("customer");
  });

  it("holds a result told at night, which the business starts, until the quiet hours end", async () => {
    const night = new Date("2026-11-04T23:00:00Z");
    const { send, drain, thread, timer } = await serving(
      [handsOff(), quiet(), replies("Good news: your refund is on its way."), quiet()],
      undefined,
      undefined,
      night,
    );
    await send("I want a refund");

    await drain();

    const held = await thread();
    expect(held.held).toMatchObject([
      { text: "Good news: your refund is on its way.", rule: "quietHours" },
    ]);
    expect(held.messages.map(({ author }) => author)).toEqual(["customer", "bot"]);
    timer.advance(9 * 60 * 60 * 1000);

    await drain();

    const sent = await thread();
    expect(sent.held).toEqual([]);
    expect(sent.messages.at(-1)).toMatchObject({
      author: "representative",
      text: "Good news: your refund is on its way.",
    });
  });

  it("is a source for the reply that tells it, by its Assignment and an exact quote", async () => {
    const { send, drain, thread, rpc } = await serving([
      handsOff(),
      quiet(),
      relays("refund of 20"),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();
    await approveDrafts(rpc);

    const { messages } = await thread();
    expect(messages.at(-1)?.text).toBe("Good news: your refund is on its way.");
    const [stored] = await getTestDb()
      .select({
        kind: representativeThreadMessage.replyKind,
        sources: representativeThreadMessage.sources,
      })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.author, "representative"));
    expect(stored).toEqual({
      kind: "answer",
      sources: [{ type: "assignment", assignmentId: expect.any(String), quote: "refund of 20" }],
    });
  });

  it("refuses a quote the result doesn't hold, and an Assignment that isn't this Turn's", async () => {
    const { send, drain, thread, fake } = await serving([
      handsOff(),
      quiet(),
      relays("refund of 2000"),
      // A reply that goes through in between, as two refusals in a row would hand off (#1261).
      replies("One moment."),
      relays("refund of 20", "019a0000-0000-7000-8000-000000000000"),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    expect(texts((await thread()).messages)).toEqual([
      "I want a refund",
      "Your refund of 20 is on its way.",
      "One moment.",
      handOffMessage,
    ]);
    const answers = (fake.calls.at(-1)!.messages as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    expect(answers.at(-3)).toContain("exact quote");
    expect(answers.at(-1)).toContain("019a0000-0000-7000-8000-000000000000");
  });

  it("waits on the owner when relaying it is refused twice, with no new Assignment", async () => {
    const { send, drain, thread, fake, botId, botFake } = await serving([
      handsOff(),
      quiet(),
      relays("refund of 2000"),
      relays("refund of 3000"),
    ]);
    await send("I want a refund");

    await drain();

    const { messages, waitingOn } = await thread();
    expect(texts(messages)).toEqual([
      "I want a refund",
      "Your refund of 20 is on its way.",
      handOffMessage,
    ]);
    expect(waitingOn).toBe("owner");
    expect(fake.calls).toHaveLength(4);
    expect(botFake.calls).toHaveLength(2);
    expect(
      await getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId)),
    ).toHaveLength(1);
  });

  it("isn't a source once it is history: the owner held it", async () => {
    let heldId = "";
    const { send, runNext, drain, thread, fake, rpc } = await serving([
      handsOff(),
      quiet(),
      (call: TextOptions) => relays("refund of 20", heldId)(call),
      quiet(),
    ]);
    await send("I want a refund");
    await runNext();
    const { id } = await thread();
    await rpc.representative.threadTakeOver({ id });
    await drain();
    await rpc.representative.threadHandBack({ id });
    [{ id: heldId }] = (await getTestDb().select({ id: botAssignment.id }).from(botAssignment)) as [
      { id: string },
    ];
    await send("Well?");
    await drain();

    expect(JSON.stringify(fake.calls.at(-2)?.messages)).not.toContain(": cite that");
    expect(texts((await thread()).messages)).not.toContain("Good news: your refund is on its way.");
    expect(JSON.stringify(fake.calls.at(-1)?.messages)).toContain("exact quote");
  });

  it("shows the Bot as who a thread waits on while the Assignment is open", async () => {
    const { send, runNext, drain, thread } = await serving([
      handsOff(),
      replies("I have asked."),
      quiet(),
      replies("Done."),
      quiet(),
    ]);
    await send("I want a refund");

    await runNext();
    expect(await thread()).toMatchObject({ waitingOn: "bot" });

    await drain();
    expect(await thread()).toMatchObject({ waitingOn: "customer" });
  });

  it("sends the Customer nothing when the result has no for_customer", async () => {
    const { fake, send, drain, thread } = await serving(
      [handsOff(), quiet()],
      [finishes({ status: "done", outcome: "Refunded." }), quiet],
    );
    await send("I want a refund");

    await drain();

    expect(fake.calls).toHaveLength(2);
    expect(texts((await thread()).messages)).toEqual(["I want a refund"]);
    const [assignment] = await getTestDb().select().from(botAssignment);
    expect(assignment).toMatchObject({ status: "done" });
  });

  it("goes to the owner during takeover: no Turn, nothing sent", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    await rpc.representative.threadTakeOver({ id: (await thread()).id });

    await drain();

    const held = await thread();
    expect(texts(held.messages)).toEqual([
      "I want a refund",
      takeoverNote,
      "Your refund of 20 is on its way.",
    ]);
    expect(held).toMatchObject({ holder: "owner", waitingOn: "owner" });
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(held.id)).toBe(1);

    // The owner decides what is sent.
    await rpc.representative.threadSend({ id: held.id, text: "It is coming." });
    expect(await thread()).toMatchObject({ waitingOn: "customer" });
    expect(fake.calls).toHaveLength(2);
  });

  it("is history to every later Turn once the owner has held it, so the Model isn't told to relay it", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([
      handsOff(),
      quiet(),
      quiet(),
    ]);
    await send("I want a refund", { rule: "sameIdentity" });
    await runNext();
    await rpc.representative.threadTakeOver({ id: (await thread()).id });
    await drain();

    await rpc.representative.threadHandBack({ id: (await thread()).id });
    expect(await thread()).toMatchObject({ holder: "representative", waitingOn: null });
    expect(await runNext()).toBe(false);

    await send("Anything else?", { rule: "sameIdentity" });
    expect(await runNext()).toBe(true);

    const prompt = JSON.stringify(fake.calls.at(-1)?.messages);
    expect(prompt).toContain("Your refund of 20 is on its way.");
    expect(prompt).toContain("An earlier result of work you handed to the Bot");
    expect(prompt).not.toContain("Tell the Customer what it says");
  });

  it("isn't the Model's to tell when it came during a hold with a Customer's message waiting", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([
      handsOff(),
      quiet(),
      quiet(),
    ]);
    await send("I want a refund", { rule: "sameIdentity" });
    await runNext();
    await rpc.representative.threadTakeOver({ id: (await thread()).id });
    await send("Well?", { rule: "sameIdentity" });
    await drain();

    await rpc.representative.threadHandBack({ id: (await thread()).id });
    expect(await runNext()).toBe(true);

    const prompt = JSON.stringify(fake.calls.at(-1)?.messages);
    expect(prompt).toContain("Well?");
    expect(prompt).toContain("Your refund of 20 is on its way.");
    expect(prompt).not.toContain("Tell the Customer what it says");
  });

  it("is history too when it was for an unverified sender", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([
      handsOff(),
      quiet(),
      quiet(),
    ]);
    await send("I want a refund");
    await runNext();
    await rpc.representative.threadTakeOver({ id: (await thread()).id });
    await drain();
    await rpc.representative.threadHandBack({ id: (await thread()).id });

    await send("Anything else?", { rule: "sameIdentity" });
    expect(await runNext()).toBe(true);

    const prompt = JSON.stringify(fake.calls.at(-1)?.messages);
    expect(prompt).toContain("Your refund of 20 is on its way.");
    expect(prompt).toContain("for an unverified sender");
    expect(prompt).not.toContain("Tell them only what is safe");
  });

  it("is kept in a thread that has closed, and sends nothing", async () => {
    const { fake, send, runNext, drain, thread } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    const { id } = await thread();
    await getTestDb()
      .update(representativeThread)
      .set({ state: "closed" })
      .where(eq(representativeThread.id, id));

    await drain();

    const { messages, waitingOn } = await thread();
    expect(texts(messages)).toEqual(["I want a refund", "Your refund of 20 is on its way."]);
    expect(waitingOn).toBeNull();
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(id)).toBe(1);
  });

  it("is kept for the owner, and wakes no Turn, when the Customer is blocked", async () => {
    const { fake, send, runNext, drain, thread, rpc } = await serving([handsOff(), quiet()]);
    await send("I want a refund");
    await runNext();
    const { id, customer } = await thread();
    await rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await drain();

    expect(texts((await thread()).messages)).toEqual([
      "I want a refund",
      "Your refund of 20 is on its way.",
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(await turnsOf(id)).toBe(1);
  });

  it("goes back to the unverified sender it was handed off for, whom nothing moved", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("It is on its way."),
      quiet(),
    ]);
    await send("I want a refund");

    await drain();

    const { messages } = await thread();
    expect(messages.map((message) => message.verified)).toEqual([false, false, false]);
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("Your refund of 20");
  });

  it("leaves a Turn that starts on it able to prove its unverified sender, by the rule of their last message", async () => {
    const { fake, send, drain, proofsSent } = await serving([
      handsOff(),
      quiet(),
      round(toolCall({ name: "verify_customer", input: {} })),
      quiet(),
    ]);
    await send("I want a refund", { rule: "codeRoundTrip" });

    await drain();

    await vi.waitFor(() => expect(proofsSent).toHaveLength(1));
    expect(proofsSent[0]).toMatchObject({ channel: fakeChannel, kind: "code" });
    const turn = fake.calls.at(-2)!;
    expect(JSON.stringify(turn.messages)).toContain("Your refund of 20");
    expect(JSON.stringify(turn.messages)).toContain("isn't verified");
  });

  it("stays an unverified sender's when they pass a code while the Bot works", async () => {
    const { fake, send, drain, runNext, thread, proofsSent } = await serving([
      round(toolCall({ name: "verify_customer", input: {} })),
      handsOff(),
      quiet(),
      quiet(),
      quiet(),
    ]);
    await send("I want a refund", { rule: "codeRoundTrip" });
    await runNext();
    await vi.waitFor(() => expect(proofsSent).toHaveLength(1));

    await send(proofsSent[0]!.secret, { rule: "codeRoundTrip" });
    await drain();

    const { messages } = await thread();
    expect(messages.find((message) => message.author === "bot")?.verified).toBe(false);
    expect(
      messages.find((message) => message.author === "customer" && message.verified),
    ).toBeTruthy();
    const told = fake.calls.filter((call) => JSON.stringify(call.messages).includes("Your refund"));
    expect(told.length).toBeGreaterThan(0);
    for (const call of told) {
      const inPrompt = JSON.stringify(call.messages);
      const verifiedTurn = !JSON.stringify(call.messages).includes("isn't verified");
      if (verifiedTurn) expect(inPrompt).toContain("for an unverified sender to be told");
    }
  });

  it("tells a Turn that starts on it that a verified sender is verified", async () => {
    const { fake, send, drain } = await serving([handsOff(), quiet(), quiet()]);
    await send("I want a refund", { rule: "sameIdentity" });

    await drain();

    const standing = JSON.stringify(fake.calls.at(-1)!.messages);
    expect(standing).toContain("is verified");
    expect(standing).not.toContain("isn't verified");
  });

  it("goes to a verified Customer where they were last heard, and the Turn labels it as the Bot's", async () => {
    const { fake, send, drain, thread } = await serving([
      handsOff(),
      quiet(),
      replies("It is on its way."),
      quiet(),
    ]);
    await send("I want a refund", { rule: "sameIdentity" });

    await drain();

    const { messages } = await thread();
    expect(messages.map((message) => message.verified)).toEqual([true, true, true]);
    expect(messages[2]).toMatchObject({ author: "representative", channel: fakeChannel });
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).toContain("written by the Bot");
  });
});
