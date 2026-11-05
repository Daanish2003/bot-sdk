import type { AnyTextAdapter } from "@tanstack/ai";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, reapStaleJobs } from "@botsdk/bot/runner/internal";
import { botAssignment, job, jobEvent } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  claimPastDeliveries,
  startTestCustomerTurn,
  autoSource,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeHandOff, representativeThread } from "../src/server/db/schema";
import { handOffMessage } from "../src/server/replies";
import { rules } from "../src/server/turn";
import type { Draft, RepresentativeTool } from "../src/shared/contract";

/*
 * A second refusal hands off (ticket #1261): from a fake Channel through a Representative Turn, with
 * a fake Model on real Postgres. A reply refused for its sources gets one retry; a refused retry
 * sends the Customer a fixed message and hands off, in code. The clock is the test's, and it runs
 * the jobs by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
/** A reply no source backs: code refuses it. */
const guess = (text: string) =>
  toolCall({ name: "reply", input: { topic: "general", text, kind: "answer" } });
const guesses = (text: string) => round(guess(text));
const greets = (text: string) =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [autoSource], text, kind: "small_talk" },
    }),
  );
const handsOff = () =>
  toolCall({
    name: "hand_to_bot",
    input: { title: "A refund", instructions: "They want a refund." },
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

type Options = {
  /** No Bot to report to. */
  noBot?: boolean;
  tools?: RepresentativeTool[];
  /** Runs when a Model call has answered, before its tools run, with how many have begun. */
  afterCall?: (call: number) => Promise<void>;
  /** Holds a Model call before it answers, with how many have begun. */
  before?: (call: number) => Promise<void>;
};

/** A Representative serving a first Release, on a clock the test moves. */
async function serving(rounds: Round[], { noBot, tools, afterCall, before }: Options = {}) {
  const fake = createFakeAdapter({ rounds });
  let begun = 0;
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      const call = ++begun;
      await before?.(call);
      yield* fake.adapter.chatStream(options);
      await afterCall?.(call);
    },
  };
  const botFake = createFakeAdapter({ rounds: Array.from({ length: 20 }, () => quiet()) });
  const timer = fakeJobClock(new Date("2026-06-01T09:00:00Z"));
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
    adapterFor: (id) => (id === botModel ? botFake.adapter : adapter),
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
  const botId = noBot ? undefined : (await rpc.bots.create({ name: "Clerk", model: botModel })).id;
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, ...(tools ? { tools } : {}) },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });

  const running: Array<Promise<void>> = [];
  const claim = async ({ overdue = false } = {}) => {
    const claimed = await claimPastDeliveries(jobs, timer.clock.now(), {
      respectRunAfter: !overdue,
    });
    if (!claimed) return false;
    running.push(jobs.runClaimed(claimed, {}));
    return true;
  };
  const thread = async () => {
    const [summary] = await rpc.representative.threadList({ id });
    return rpc.representative.threadGet({ id: summary!.id });
  };
  const send = (message: string) =>
    startTestCustomerTurn(deps!, { representativeId: id, externalId: "+15550001", message });
  return {
    fake,
    began: () => begun,
    deps,
    rpc,
    id,
    botId,
    timer,
    claim,
    thread,
    send,
    attemptsEnd: () => Promise.all(running),
    /** Runs what is left to its end, the Bot's jobs too. */
    drain: async () => {
      await Promise.all(running);
      while (await claim({ overdue: true })) await Promise.all(running);
    },
    /** Sends the Customer's message and runs its Turn to the end. */
    turn: async (message = "How much is a haircut?") => {
      await send(message);
      timer.advance(500);
      await claim();
      await Promise.all(running);
    },
    /** What the Representative's side sent the Customer. */
    sent: async () =>
      (await thread()).messages.filter((entry) => entry.author === "representative"),
    /** What was handed to the Bot. */
    assignments: () =>
      botId
        ? getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId))
        : Promise.resolve([]),
    leaseLost: async () => {
      timer.advance(61_000);
      await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps!.parts.jobs);
      timer.tick();
    },
  };
}

const textsOf = (messages: Array<{ text: string }>) => messages.map((entry) => entry.text);

describe("a reply refused for its sources", () => {
  it("gets a retry the first time, and a valid retry reaches the Customer", async () => {
    const { turn, sent, assignments, fake, thread } = await serving([
      guesses("A haircut is 10 USD."),
      greets("Let me ask about that."),
      quiet(),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual(["Let me ask about that."]);
    expect(await assignments()).toEqual([]);
    // The Model heard why, and went on to the end of its Turn.
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain("Nothing was sent");
    expect(fake.calls).toHaveLength(3);
    expect((await thread()).waitingOn).toBe("customer");
  });

  it("gets a retry again once a reply has gone through since", async () => {
    const { turn, sent, assignments } = await serving([
      guesses("A haircut is 10 USD."),
      greets("Let me ask about that."),
      guesses("It is 12 USD."),
      greets("Bear with me."),
      quiet(),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual(["Let me ask about that.", "Bear with me."]);
    expect(await assignments()).toEqual([]);
  });
});

describe("a second refusal", () => {
  it("sends the fixed message, ties an Assignment to the thread and ends the Turn", async () => {
    const { turn, sent, assignments, fake, thread } = await serving([
      guesses("A haircut is 10 USD."),
      guesses("A haircut is 12 USD."),
      greets("Never sent: the Turn has ended."),
    ]);

    await turn("How much is a haircut?");

    const { id: threadId, messages, waitingOn } = await thread();
    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect((await sent())[0]?.reply).toEqual({ kind: "code_handoff", sources: [] });
    expect(JSON.stringify(messages)).not.toMatch(/10 USD|12 USD/);
    expect(fake.calls).toHaveLength(2);
    expect(waitingOn).toBe("bot");

    const [assignment, ...others] = await assignments();
    expect(others).toEqual([]);
    const [handOff] = await getTestDb()
      .select()
      .from(representativeHandOff)
      .where(eq(representativeHandOff.assignmentId, assignment!.id));
    expect(handOff).toMatchObject({ threadId, verified: false, channel: "fake" });
    // The Bot hears what the Customer asked, as a claim, and not what code refused.
    expect(assignment!.instructions).toContain("How much is a haircut?");
    expect(assignment!.instructions).toContain("isn't verified");
    expect(assignment!.instructions).not.toMatch(/10 USD|12 USD/);
  });

  it("counts a refused document quote like any other refusal", async () => {
    const { turn, sent, assignments } = await serving([
      round(
        toolCall({
          name: "reply",
          input: {
            topic: "general",
            text: "It is 10 USD.",
            kind: "answer",
            sources: [{ type: "document", name: "prices.md", quote: "10 USD" }],
          },
        }),
      ),
      guesses("It is 12 USD."),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
  });

  it("needs no hand_to_bot in the Release", async () => {
    const { turn, sent, assignments } = await serving(
      [guesses("It is 10 USD."), guesses("It is 12 USD.")],
      { tools: ["reply"] },
    );

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
  });

  it("with no Bot opens nothing, tells the Customer, and shows it waits on the owner", async () => {
    const { turn, sent, thread, rpc, fake } = await serving(
      [guesses("It is 10 USD."), guesses("It is 12 USD."), quiet(), quiet()],
      { noBot: true },
    );

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect((await thread()).waitingOn).toBe("owner");
    const [summary] = await rpc.representative.threadList({
      id: (await thread()).representativeId,
    });
    expect(summary?.waitingOn).toBe("owner");
    expect(fake.calls).toHaveLength(2);
    expect(
      await getTestDb()
        .select()
        .from(representativeHandOff)
        .where(eq(representativeHandOff.threadId, (await thread()).id)),
    ).toEqual([]);

    // The Customer writing again is a new Turn's to answer, not the owner's.
    await turn("Hello?");
    expect((await thread()).waitingOn).toBe(null);
  });

  it("opens no second Assignment on a Turn that already handed off", async () => {
    const { turn, sent, assignments, fake } = await serving([
      round(handsOff()),
      guesses("It is 10 USD."),
      guesses("It is 12 USD."),
    ]);

    await turn();

    expect(await assignments()).toHaveLength(1);
    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(fake.calls).toHaveLength(3);
  });

  it("runs nothing the Model called after it in the same Step", async () => {
    const { turn, sent, assignments, fake } = await serving([
      round(
        guess("It is 10 USD."),
        guess("It is 12 USD."),
        handsOff(),
        toolCall({
          name: "reply",
          input: {
            topic: "general",
            sources: [autoSource],
            text: "One more thing.",
            kind: "small_talk",
          },
        }),
      ),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("sends no fixed message and opens no Assignment on a thread the owner took over", async () => {
    const made = await serving([guesses("It is 10 USD."), guesses("It is 12 USD."), quiet()], {
      afterCall: async (call) => {
        if (call === 2) {
          await made.rpc.representative.threadTakeOver({ id: (await made.thread()).id });
        }
      },
    });

    await made.turn();

    expect(await made.sent()).toEqual([]);
    expect(await made.assignments()).toEqual([]);
  });

  it("sends nothing when the thread stops being this Turn's as it writes, and ends the Turn", async () => {
    // The owner's commit landing between the Turn's last check and its write: its job isn't cancelled yet.
    const made = await serving(
      [guesses("It is 10 USD."), guesses("It is 12 USD."), greets("Never sent.")],
      {
        afterCall: async (call) => {
          if (call === 2) {
            await getTestDb()
              .update(representativeThread)
              .set({ state: "owner" })
              .where(eq(representativeThread.id, (await made.thread()).id));
          }
        },
      },
    );

    await made.turn();

    expect(await made.sent()).toEqual([]);
    expect(await made.assignments()).toEqual([]);
    expect(made.fake.calls).toHaveLength(2);
  });

  it("sends nothing to a Customer blocked before it", async () => {
    const made = await serving([guesses("It is 10 USD."), guesses("It is 12 USD."), quiet()], {
      afterCall: async (call) => {
        if (call === 2) {
          const { customer } = await made.thread();
          await made.rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
        }
      },
    });

    await made.turn();

    expect(await made.sent()).toEqual([]);
    expect(await made.assignments()).toEqual([]);
  });

  it("lets a thread wait on the owner when the Bot can't take the work", async () => {
    const made = await serving([guesses("It is 10 USD."), guesses("It is 12 USD.")]);
    const { assignments } = made.deps.parts.features[0]!.context;
    const { ORPCError } = await import("@orpc/contract");
    vi.spyOn(assignments!, "create").mockRejectedValueOnce(new ORPCError("CONFLICT"));

    await made.turn();

    expect(textsOf(await made.sent())).toEqual([handOffMessage]);
    expect(await made.assignments()).toEqual([]);
    expect((await made.thread()).waitingOn).toBe("owner");
  });

  it("opens the Assignment whatever the Customer wrote, within what an Assignment takes", async () => {
    const made = await serving([guesses("It is 10 USD."), guesses("It is 12 USD.")]);
    // Long, three bytes a character, and with a run of backticks its fence must outgrow.
    const long = "語".repeat(14_000) + "`".repeat(1_000);
    const backticks = "`".repeat(20_000);
    await made.send(long);
    await made.send(backticks);
    await made.send(long);
    made.timer.advance(500);
    await made.claim();
    await made.attemptsEnd();

    expect(textsOf(await made.sent())).toEqual([handOffMessage]);
    expect(await made.assignments()).toHaveLength(1);
  });

  it("hints the Bot's Conversation once the hand-off has committed", async () => {
    const made = await serving([guesses("It is 10 USD."), guesses("It is 12 USD.")]);
    const { threads } = made.deps.parts.features[0]!.context;
    const seen: number[] = [];
    vi.spyOn(threads!, "hintChanged").mockImplementation(async () => {
      seen.push((await made.assignments()).length);
    });

    await made.turn();

    // Read outside the hand-off's transaction, so it had committed.
    expect(seen).toEqual([1]);
  });
});

describe("a crash replay of the refusals", () => {
  it("counts the first as it was, so the retry hands off", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const { send, sent, claim, timer, drain, leaseLost, began, assignments } = await serving(
      // The stalled attempt's second call saves nothing, so the next attempt makes it again.
      [guesses("It is 10 USD."), guesses("It is 12 USD."), guesses("It is 12 USD.")],
      // The first refusal is checkpointed once the second Model call has begun.
      { before: async (call) => void (call === 2 && (await opened)) },
    );
    await send("How much?");
    timer.advance(500);
    await claim();
    await expect.poll(began, poll).toBe(2);

    await leaseLost();
    open();
    await drain();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
  });

  it("sends the message and opens the Assignment once, when it crashed after them", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const { deps, send, sent, claim, timer, drain, leaseLost, assignments, thread } = await serving(
      [guesses("It is 10 USD."), guesses("It is 12 USD.")],
    );
    let hinted = false;
    const { threads } = deps.parts.features[0]!.context;
    // Held after the hand-off's commit: this attempt goes no further until its lease has gone.
    vi.spyOn(threads!, "hintChanged").mockImplementationOnce(async () => {
      hinted = true;
      await opened;
    });
    await send("How much?");
    timer.advance(500);
    await claim();
    await expect.poll(() => hinted, poll).toBe(true);
    expect(textsOf(await sent())).toEqual([handOffMessage]);

    await leaseLost();
    open();
    await drain();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
    expect((await thread()).waitingOn).toBe("bot");
  });
});

describe("a second refusal in a test conversation", () => {
  async function played(draft: Partial<Draft> = {}, withBot = true) {
    const made = await serving(
      [guesses("It is 10 USD."), guesses("It is 12 USD."), greets("Never sent.")],
      { noBot: !withBot },
    );
    const { rpc, id, timer, claim, attemptsEnd } = made;
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [
          {
            name: "A guess",
            message: "How much?",
            expect: [
              { kind: "handed_off" },
              { kind: "said", text: handOffMessage },
              { kind: "not_said", text: "10 USD" },
              { kind: "not_said", text: "12 USD" },
              { kind: "not_said", text: "Never sent" },
            ],
          },
        ],
        ...draft,
      },
    });
    await rpc.representative.runTests({ id });
    timer.advance(500);
    await claim({ overdue: true });
    await attemptsEnd();
    return { ...made, result: await rpc.representative.get({ id }) };
  }

  it("counts as handed off and reaches nothing real", async () => {
    const { result, assignments, rpc, id, fake } = await played();

    expect(result.testStatus).toBe("passed");
    expect(result.tests[0]?.checks.map((check) => check.passed)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(result.tests[0]?.transcript).toContainEqual({
      role: "representative",
      text: handOffMessage,
      reply: { kind: "code_handoff", sources: [] },
    });
    expect(fake.calls).toHaveLength(2);
    expect(await assignments()).toEqual([]);
    expect(await rpc.representative.threadList({ id })).toEqual([]);
  });

  it("doesn't count a test's own limit on what it can read back, which a live Turn hasn't", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    const { rpc, id, timer, claim, attemptsEnd } = await serving([
      guesses("It is 10 USD."),
      round(
        toolCall({
          name: "reply",
          input: {
            topic: "general",
            text: keys.map((key) => `{{${key}}}`).join(" "),
            kind: "answer",
          },
        }),
      ),
      quiet(),
    ]);
    for (const key of keys) {
      await rpc.representative.factAdd({
        key,
        type: "text",
        topic: "General",
        value: key.repeat(1_900),
      });
    }
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [
          {
            name: "Terms",
            message: "Terms?",
            expect: [
              { kind: "not_handed_off" },
              { kind: "replied" },
              { kind: "said", text: "aaa" },
            ],
          },
        ],
      },
    });
    await rpc.representative.runTests({ id });
    timer.advance(500);
    await claim({ overdue: true });
    await attemptsEnd();

    expect((await rpc.representative.get({ id })).testStatus).toBe("passed");
  });

  it("counts as handed off with no Bot too", async () => {
    const { result } = await played({}, false);

    expect(result.testStatus).toBe("passed");
  });
});

describe("a Turn ending with a refusal outstanding", () => {
  it.each([
    ["goes quiet", [guesses("It is 10 USD."), quiet()], 2],
    [
      "writes plain text, and then nothing",
      [guesses("It is 10 USD."), round(text("10 USD.")), quiet()],
      3,
    ],
    [
      "uses its last Step on it",
      [...Array.from({ length: 9 }, () => greets("One moment.")), guesses("It is 10 USD.")],
      10,
    ],
    ["hits a Model error", [guesses("It is 10 USD.")], 2],
  ] as Array<[string, Round[], number]>)(
    "hands off in code when the Model %s",
    async (_name, rounds, calls) => {
      const { turn, sent, assignments, fake, thread } = await serving(rounds);

      await turn();

      expect(textsOf(await sent()).at(-1)).toBe(handOffMessage);
      expect(JSON.stringify(await sent())).not.toContain("10 USD");
      expect(await assignments()).toHaveLength(1);
      expect(fake.calls.length).toBeLessThanOrEqual(calls);
      expect((await thread()).waitingOn).toBe("bot");
    },
  );

  it("waits on the owner with no Bot", async () => {
    const { turn, sent, thread } = await serving([guesses("It is 10 USD."), quiet()], {
      noBot: true,
    });

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect((await thread()).waitingOn).toBe("owner");
  });

  it("doesn't hand off once a reply has gone through since", async () => {
    const { turn, sent, assignments } = await serving([
      guesses("It is 10 USD."),
      greets("Let me ask about that."),
      quiet(),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual(["Let me ask about that."]);
    expect(await assignments()).toEqual([]);
  });

  it("opens no second Assignment on a Turn that already handed off, and still tells the Customer", async () => {
    const { turn, sent, assignments } = await serving([
      guesses("It is 10 USD."),
      round(handsOff()),
      quiet(),
    ]);

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
  });

  it("sends nothing on a thread that stopped being this Turn's", async () => {
    const made = await serving([guesses("It is 10 USD."), quiet()], {
      afterCall: async (call) => {
        if (call === 2) {
          await getTestDb()
            .update(representativeThread)
            .set({ state: "owner" })
            .where(eq(representativeThread.id, (await made.thread()).id));
        }
      },
    });

    await made.turn();

    expect(await made.sent()).toEqual([]);
    expect(await made.assignments()).toEqual([]);
  });

  it("sends nothing on a thread the owner took over", async () => {
    const made = await serving([guesses("It is 10 USD."), quiet()], {
      afterCall: async (call) => {
        if (call === 2) {
          await made.rpc.representative.threadTakeOver({ id: (await made.thread()).id });
        }
      },
    });

    await made.turn();

    expect(await made.sent()).toEqual([]);
    expect(await made.assignments()).toEqual([]);
  });

  it("hands off once when a crash replays it", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const { deps, send, sent, claim, timer, drain, leaseLost, assignments } = await serving([
      guesses("It is 10 USD."),
      quiet(),
    ]);
    let hinted = false;
    const { threads } = deps.parts.features[0]!.context;
    // Held after the hand-off's commit: this attempt goes no further until its lease has gone.
    vi.spyOn(threads!, "hintChanged").mockImplementationOnce(async () => {
      hinted = true;
      await opened;
    });
    await send("How much?");
    timer.advance(500);
    await claim();
    await expect.poll(() => hinted, poll).toBe(true);

    await leaseLost();
    open();
    await drain();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(await assignments()).toHaveLength(1);
  });

  it("counts as handed off in a test conversation, and reaches nothing real", async () => {
    const { rpc, id, timer, claim, attemptsEnd, assignments } = await serving([
      guesses("It is 10 USD."),
      quiet(),
    ]);
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [
          {
            name: "A guess",
            message: "How much?",
            expect: [
              { kind: "handed_off" },
              { kind: "said", text: handOffMessage },
              { kind: "not_said", text: "10 USD" },
            ],
          },
        ],
      },
    });
    await rpc.representative.runTests({ id });
    timer.advance(500);
    await claim({ overdue: true });
    await attemptsEnd();

    const { testStatus, tests } = await rpc.representative.get({ id });
    expect(testStatus).toBe("passed");
    expect(tests[0]?.transcript).toContainEqual({
      role: "representative",
      text: handOffMessage,
      reply: { kind: "code_handoff", sources: [] },
    });
    expect(await assignments()).toEqual([]);
  });
});

describe("a cant_confirm reply with no question", () => {
  it("counts as a refusal, so a Model repeating it hands off", async () => {
    const repeats = () =>
      round(
        toolCall({
          name: "reply",
          input: { topic: "general", text: "I can't confirm that.", kind: "cant_confirm" },
        }),
      );
    const { turn, sent, fake } = await serving([repeats(), repeats(), repeats(), repeats()]);

    await turn();

    expect(textsOf(await sent())).toEqual([handOffMessage]);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("the system rules", () => {
  it("tell the Model how to cite a document, by name with an exact quote", () => {
    expect(rules).toMatch(/document[^.]*name[^.]*exact quote/i);
  });
});

describe("a test conversation's reply", () => {
  it("counts as sent however long what it cites, as it would in a live Turn", async () => {
    const { rpc, id, timer, claim, attemptsEnd } = await serving([
      round(
        toolCall({
          name: "reply",
          input: {
            topic: "general",
            text: "Here you go.",
            kind: "answer",
            sources: [{ type: "document", name: "terms.md", quote: "q".repeat(11_000) }],
          },
        }),
      ),
      quiet(),
    ]);
    await rpc.representative.documentUpload({
      id,
      file: new File(["q".repeat(12_000)], "terms.md"),
    });
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [
          { name: "Terms", message: "Terms?", expect: [{ kind: "replied" }, { kind: "cited" }] },
        ],
      },
    });
    await rpc.representative.runTests({ id });
    timer.advance(500);
    await claim({ overdue: true });
    await attemptsEnd();

    const { tests } = await rpc.representative.get({ id });
    expect(tests[0]?.status).toBe("passed");
    expect(JSON.stringify(tests[0]?.transcript)).toContain("q".repeat(11_000));
  });
});

describe("what code takes for a typed value", () => {
  const says = async (text: string) => {
    const { turn, sent } = await serving([greets(text), quiet()]);
    await turn();
    return textsOf(await sent());
  };

  it.each([
    "I've sent a code to jane@gmail.com",
    "Write to first.me@gmail.com or a.b@mail.example.co.uk",
    "We have 24 HRS of cover, 10 USB ports and 3 PCS in stock.",
    "TOP 10 tips, and TRY 3 of them.",
    "All 5 of them.",
    "Write to order1234567890@shop.com",
    "Write to hello@www.acme.com",
    "A Ryzen 5 AMD laptop.",
  ])("lets through %s", async (text) => {
    expect(await says(text)).toEqual([text]);
  });

  it.each([
    "See gmail.com for it.",
    "It costs 50 CAD.",
    "It costs CHF 50.",
    "It costs ₹4500.",
    "It costs 1200 JPY.",
    "It costs ₩9000.",
    "It costs 500 TRY.",
    "Go to pay@evil.com/reset",
  ])("refuses %s", async (text) => {
    expect(await says(text)).toEqual([handOffMessage]);
  });
});

describe("what code takes for a typed value, from a fact", () => {
  it("lets a fact's value through whole, a sign and a code together", async () => {
    const { rpc, turn, sent } = await serving([
      round(
        toolCall({
          name: "reply",
          input: { topic: "general", text: "It is {{price.x}}.", kind: "answer" },
        }),
      ),
      quiet(),
    ]);
    await rpc.representative.factAdd({
      key: "price.x",
      type: "text",
      topic: "general",
      value: "$500 CAD",
    });

    await turn();

    expect(textsOf(await sent())).toEqual(["It is $500 CAD."]);
  });
});

describe("a Turn's Checkpoints", () => {
  it("hold no fact's value from a test conversation's reply either, which still reads it", async () => {
    const { rpc, id, timer, claim, attemptsEnd } = await serving([
      round(
        toolCall({
          name: "reply",
          input: { topic: "general", text: "It is {{price.haircut}}.", kind: "answer" },
        }),
      ),
      quiet(),
    ]);
    await rpc.representative.factAdd({
      key: "price.haircut",
      type: "money",
      topic: "Prices",
      value: "45 USD",
    });
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [{ name: "Price", message: "How much?", expect: [{ kind: "said", text: "is 45" }] }],
      },
    });
    await rpc.representative.runTests({ id });
    timer.advance(500);
    await claim({ overdue: true });
    await attemptsEnd();

    expect((await rpc.representative.get({ id })).testStatus).toBe("passed");
    expect(JSON.stringify(await getTestDb().select().from(jobEvent))).not.toContain("45 USD");
  });

  it("hold no fact's value, which a user delete wouldn't reach", async () => {
    const { rpc, turn, fake } = await serving([quiet()]);
    await rpc.representative.factAdd({
      key: "price.haircut",
      type: "money",
      topic: "Prices",
      value: "45 USD",
    });

    await turn();

    expect(JSON.stringify(fake.calls[0]?.messages)).toContain("45 USD");
    const events = await getTestDb().select().from(jobEvent);
    expect(JSON.stringify(events)).not.toContain("45 USD");
  });
});

describe("who a Turn's sender is", () => {
  it("leaves the system text the same for each sender, so documents cache across them", async () => {
    const { deps, id, fake, timer, claim, attemptsEnd } = await serving([quiet(), quiet()]);
    const run = async (externalId: string, proof?: { rule: "sameIdentity" }) => {
      await startTestCustomerTurn(deps, { representativeId: id, externalId, message: "Hi", proof });
      timer.advance(500);
      await claim();
      await attemptsEnd();
    };

    await run("+15550001");
    await run("+15550002", { rule: "sameIdentity" });

    const [first, second] = fake.calls;
    expect(second?.systemPrompts).toEqual(first?.systemPrompts);
    const lastOf = (call: typeof first) => JSON.stringify(call?.messages.at(-1)?.content);
    expect(lastOf(first)).toContain("isn't verified");
    expect(lastOf(second)).toContain("is verified");
    expect(lastOf(second)).not.toContain("isn't verified");
  });
});
