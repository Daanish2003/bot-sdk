import type { AnyTextAdapter } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, reapStaleJobs } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import {
  approveDrafts,
  autoFact,
  claimPastDeliveries,
  startTestCustomerTurn,
} from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { factsPromptChars, handOffMessage } from "../src/server/replies";
import type { Expectation } from "../src/shared/contract";
import {
  representativeCustomer,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";

/*
 * A reply quoting a Published fact by key, and the check of its kind and sources (ticket #1260):
 * from a fake Channel through a Representative Turn, with a fake Model on real Postgres. The clock
 * is the test's, and it runs the jobs by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const leaseLapse = 61_000;
const day = 24 * 60 * 60 * 1000;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (input: object) =>
  round(toolCall({ name: "reply", input: { topic: "general", ...input } }));
const answers = (text: string, sources: object[] = [{ type: "fact", key: "price.haircut" }]) =>
  replies({ text, kind: "answer", sources });

const price = { key: "price.haircut", type: "money", topic: "general", value: "45 USD" } as const;

const priceEdit = (id: string, value: string) => ({
  id,
  type: price.type,
  topic: price.topic,
  value,
  validFrom: null,
  validUntil: null,
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
  /** Runs when a Model call has answered, before its tools run, with how many have begun. */
  afterCall?: (calls: number) => Promise<void>;
  /** Holds a Model call before it answers, with how many have begun. */
  before?: (calls: number) => Promise<void>;
};

/** A Representative serving a first Release on a clock the test moves. */
async function serving(rounds: Round[], { afterCall, before }: Options = {}) {
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
  const claim = async ({ overdue = false } = {}) => {
    const claimed = await claimPastDeliveries(jobs, timer.clock.now(), {
      respectRunAfter: !overdue,
    });
    if (!claimed) return false;
    running.push(jobs.runClaimed(claimed, {}));
    return true;
  };
  return {
    fake,
    began: () => begun,
    deps,
    user,
    rpc,
    id,
    timer,
    claim,
    attemptsEnd: () => Promise.all(running),
    send: (message = "How much is a haircut?") =>
      startTestCustomerTurn(deps!, { representativeId: id, externalId: "+15550001", message }),
    /** Sends the Customer's message and runs its Turn to the end. */
    turn: async (message = "How much is a haircut?") => {
      await startTestCustomerTurn(deps!, {
        representativeId: id,
        externalId: "+15550001",
        message,
      });
      timer.advance(500);
      await claim();
      await Promise.all(running);
    },
    sent: () =>
      getTestDb()
        .select({
          text: representativeThreadMessage.text,
          kind: representativeThreadMessage.replyKind,
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
        )
        .orderBy(representativeThreadMessage.position),
    leaseLost: async () => {
      timer.advance(leaseLapse);
      await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps!.parts.jobs);
      timer.tick();
    },
  };
}

/** What the tools answered in the Model's last call. */
const answersIn = (call: { messages: unknown } | undefined) =>
  ((call?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content));

const promptOf = (call: { messages: unknown } | undefined) =>
  (call?.messages ?? []) as Array<{ role: string; content: unknown }>;

describe("a reply quoting a fact by key", () => {
  it("reaches the Customer and the thread with code's value, and the key never shows", async () => {
    const { rpc, id, turn, sent, fake } = await serving([
      answers("A haircut is {{price.haircut}}, thanks."),
      quiet(),
      quiet(),
    ]);
    await rpc.representative.factAdd(price);

    await turn();

    expect(await sent()).toEqual([
      expect.objectContaining({ text: "A haircut is 45 USD, thanks." }),
    ]);
    const [summary] = await rpc.representative.threadList({ id });
    const { messages } = await rpc.representative.threadGet({ id: summary!.id });
    expect(messages.at(-1)?.text).toBe("A haircut is 45 USD, thanks.");

    // A later Turn reads what was sent, not what the Model wrote.
    await turn("And a beard trim?");
    const thread = JSON.stringify(promptOf(fake.calls.at(-1)).slice(1));
    expect(thread).toContain("A haircut is 45 USD, thanks.");
    expect(thread).not.toContain("{{");
  });

  it("shows the owner each reply's kind and sources, and an older reply as having none", async () => {
    const { rpc, id, turn } = await serving([answers("A haircut is {{price.haircut}}."), quiet()]);
    await rpc.representative.factAdd(price);

    await turn();

    const [summary] = await rpc.representative.threadList({ id });
    const { messages } = await rpc.representative.threadGet({ id: summary!.id });
    expect(messages.map(({ author, reply }) => ({ author, reply }))).toEqual([
      { author: "customer", reply: null },
      {
        author: "representative",
        reply: { kind: "answer", sources: [{ type: "fact", key: "price.haircut" }] },
      },
    ]);

    await getTestDb()
      .update(representativeThreadMessage)
      .set({ replyKind: null, sources: null })
      .where(eq(representativeThreadMessage.author, "representative"));
    const older = await rpc.representative.threadGet({ id: summary!.id });
    expect(older.messages.at(-1)?.reply).toEqual({ kind: null, sources: [] });
  });

  it("inserts the fact's value now, whatever the Model saw or wrote beside the key", async () => {
    let factId = "";
    const made = await serving(
      [
        replies({
          text: "{{price.haircut}}, not the price I saw.",
          kind: "answer",
          sources: [{ type: "fact", key: "price.haircut", value: "1 USD" }],
        }),
        quiet(),
      ],
      {
        afterCall: async (call) => {
          if (call === 1) await made.rpc.representative.factEdit(priceEdit(factId, "60 USD"));
        },
      },
    );
    factId = (await made.rpc.representative.factAdd(price)).id;

    await made.turn();

    expect(JSON.stringify(promptOf(made.fake.calls[0]))).toContain("45 USD");
    expect((await made.sent())[0]).toMatchObject({
      text: "60 USD, not the price I saw.",
      sources: [{ type: "fact", key: "price.haircut" }],
    });
  });

  it("inserts a value holding a replacement pattern as it stands", async () => {
    const { rpc, turn, sent } = await serving([
      answers("See {{note}}.", [{ type: "fact", key: "note" }]),
      quiet(),
    ]);
    await rpc.representative.factAdd({
      key: "note",
      type: "text",
      topic: "General",
      value: "$& and {{price.haircut}}",
    });

    await turn();

    expect((await sent())[0]?.text).toBe("See $& and {{price.haircut}}.");
  });

  it("refuses an unknown key with the reason, and sends nothing", async () => {
    const { turn, sent, fake } = await serving([
      replies({ text: "It is {{price.beard}}.", kind: "small_talk" }),
      quiet(),
    ]);

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    const [answer] = answersIn(fake.calls[1]);
    expect(answer).toContain("price.beard");
    expect(answer).toContain("error");
  });

  it("refuses a key before and after its valid dates, and takes it between them", async () => {
    const { rpc, turn, sent, fake, timer } = await serving([
      answers("It is {{price.haircut}}."),
      quiet(),
      answers("It is {{price.haircut}}."),
      quiet(),
      answers("It is {{price.haircut}}."),
      quiet(),
    ]);
    const now = timer.clock.now().getTime();
    await rpc.representative.factAdd({
      ...price,
      validFrom: new Date(now + day),
      validUntil: new Date(now + 3 * day),
    });

    await turn();
    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/price\.haircut.*in effect/);

    timer.advance(2 * day);
    await turn("Now?");
    expect((await sent()).map((message) => message.text)).toEqual([
      handOffMessage,
      "It is 45 USD.",
    ]);

    timer.advance(2 * day);
    await turn("And now?");
    expect((await sent()).map((message) => message.text)).toEqual([
      handOffMessage,
      "It is 45 USD.",
      handOffMessage,
    ]);
    expect(answersIn(fake.calls[5])[0]).toMatch(/price\.haircut.*in effect/);
  });

  it("refuses a broken key rather than show it", async () => {
    const { rpc, turn, sent, fake } = await serving([answers("It is {{price.haircut."), quiet()]);
    await rpc.representative.factAdd(price);

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toContain("error");
  });

  it.each(["It is {{{price.haircut}}}.", "It is {price.haircut}."])(
    "refuses braces meant as a key: %s",
    async (text) => {
      const { rpc, turn, sent, fake } = await serving([answers(text), quiet()]);
      await rpc.representative.factAdd(price);

      await turn();

      expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
      expect(answersIn(fake.calls[1])[0]).toContain("broken");
    },
  );

  it("refuses a reply too long to send once its values are in", async () => {
    const { rpc, turn, sent, fake } = await serving([
      answers(`${"x".repeat(59_990)}{{note}}`, [{ type: "fact", key: "note" }]),
      quiet(),
    ]);
    await rpc.representative.factAdd({
      key: "note",
      type: "text",
      topic: "General",
      value: "A value that takes it over the limit",
    });

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/too long/);
  });
});

describe("a reply quoting a lot", () => {
  const keys = ["a", "b", "c", "d", "e"];
  const longFact = (key: string) => ({
    key,
    type: "text" as const,
    topic: "General",
    value: key.repeat(1_900),
  });

  it("goes through on a live Turn", async () => {
    const { rpc, turn, sent } = await serving([
      replies({ text: keys.map((key) => `{{${key}}}`).join(" "), kind: "answer" }),
      quiet(),
    ]);
    for (const key of keys) await rpc.representative.factAdd(longFact(key));

    await turn();

    expect((await sent())[0]?.text).toBe(keys.map((key) => key.repeat(1_900)).join(" "));
  });
});

describe("a reply's kind and sources", () => {
  it("refuses a reply that needs a source and has none, with the reason", async () => {
    const { turn, sent, fake } = await serving([
      replies({ text: "A haircut is cheap.", kind: "answer" }),
      quiet(),
    ]);

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/source/);
  });

  it("refuses a source naming a fact that doesn't exist, with the reason", async () => {
    const { rpc, turn, sent, fake } = await serving([
      answers("A haircut is fairly priced.", [
        { type: "fact", key: "price.haircut" },
        { type: "fact", key: "price.invented" },
      ]),
      quiet(),
    ]);
    await rpc.representative.factAdd(price);

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toContain("price.invented");
  });

  it("refuses a source naming a fact out of its valid dates", async () => {
    const { rpc, turn, sent, fake, timer } = await serving([
      answers("A haircut is fairly priced."),
      quiet(),
    ]);
    await rpc.representative.factAdd({
      ...price,
      validUntil: new Date(timer.clock.now().getTime() + 1),
    });
    timer.advance(day);

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/price\.haircut.*in effect/);
  });

  it("takes small talk and a hand-off with no source", async () => {
    const { turn, sent, rpc } = await serving([
      replies({ text: "Hello!", kind: "small_talk" }),
      replies({ text: "Someone will take this up.", kind: "handoff" }),
      quiet(),
    ]);

    await turn("Hi");
    // Resting on nothing, each is a draft.
    await approveDrafts(rpc);

    expect(await sent()).toEqual([
      { text: "Hello!", kind: "small_talk", sources: [] },
      { text: "Someone will take this up.", kind: "handoff", sources: [] },
    ]);
  });

  it("offers sources in a schema OpenAI's strict tools take: anyOf, never oneOf", async () => {
    const { turn, fake } = await serving([quiet()]);

    await turn("Hi");

    const reply = fake.calls[0]?.tools?.find((tool) => tool.name === "reply");
    const schema = JSON.stringify(reply!.inputSchema);
    expect(schema).toContain("anyOf");
    expect(schema).not.toContain("oneOf");
  });

  it("refuses a reply with no kind, which the Model hears", async () => {
    const { turn, sent, fake } = await serving([replies({ text: "Hello!" }), quiet()]);

    await turn("Hi");

    // The tool never ran, so this is no refusal, and the Turn still ends with nothing sent: code hands off.
    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/validation failed/i);
  });

  it("stores the sources with the message, a key in the text counting as one, and shows them to no Customer", async () => {
    const { rpc, user, deps, id, turn, sent } = await serving([
      replies({ text: "A haircut is {{price.haircut}}.", kind: "answer" }),
      quiet(),
    ]);
    await rpc.representative.factAdd(price);

    await turn();

    expect(await sent()).toEqual([
      {
        text: "A haircut is 45 USD.",
        kind: "answer",
        sources: [{ type: "fact", key: "price.haircut" }],
      },
    ]);
    // What a Customer's Channel carries is the message's text alone; only the owner's view has the sources.
    const [summary] = await rpc.representative.threadList({ id });
    const { messages } = await rpc.representative.threadGet({ id: summary!.id });
    expect(messages.at(-1)?.text).not.toContain("price.haircut");
    // The owner's export holds them, as it holds the rest of the thread.
    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: {
        customers: Array<{ threads: Array<{ messages: Array<Record<string, unknown>> }> }>;
      };
    };
    expect(exported.representative.customers[0]?.threads[0]?.messages.at(-1)).toMatchObject({
      replyKind: "answer",
      sources: [{ type: "fact", key: "price.haircut" }],
    });
  });
});

describe("a crash replay of a reply", () => {
  it("sends the same text once, though the fact changed in between", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const { rpc, send, sent, claim, timer, attemptsEnd, leaseLost, fake } = await serving(
      [answers("It is {{price.haircut}}."), quiet(), quiet()],
      // The reply is done and checkpointed once the second Model call has begun.
      { before: async (call) => void (call === 2 && (await opened)) },
    );
    const added = await rpc.representative.factAdd(price);
    await send();
    timer.advance(500);
    await claim();
    await expect.poll(sent, poll).toHaveLength(1);

    await rpc.representative.factEdit(priceEdit(added.id, "60 USD"));
    await leaseLost();
    open();
    await attemptsEnd();
    expect(await claim({ overdue: true })).toBe(true);
    await attemptsEnd();

    expect(await sent()).toEqual([expect.objectContaining({ text: "It is 45 USD." })]);
    expect(fake.calls.length).toBeGreaterThan(1);
    // A Checkpoint holds no fact's value, so the replay's next call reads the facts as they are now.
    expect(JSON.stringify(promptOf(fake.calls.at(-1))[0])).toContain("60 USD");
  });

  it("is refused again the same way, though the fact has come in since", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const { rpc, send, sent, claim, timer, attemptsEnd, leaseLost, began } = await serving(
      [answers("It is {{price.haircut}}."), quiet(), quiet()],
      { before: async (call) => void (call === 2 && (await opened)) },
    );
    await send();
    timer.advance(500);
    await claim();
    // The second call has begun, so the refusal is checkpointed.
    await expect.poll(began, poll).toBe(2);

    await rpc.representative.factAdd(price);
    await leaseLost();
    open();
    await attemptsEnd();
    expect(await claim({ overdue: true })).toBe(true);
    await attemptsEnd();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
  });
});

describe("the prompt", () => {
  it("lists the facts in effect after the system text and before the thread", async () => {
    const { rpc, turn, fake, timer } = await serving([quiet()]);
    await rpc.representative.factAdd(price);
    await rpc.representative.factAdd({
      key: "hours.week",
      type: "hours",
      topic: "Hours",
      value: "Mon-Fri 09:00-17:00",
    });
    await rpc.representative.factAdd({
      key: "price.old",
      type: "money",
      topic: "general",
      value: "99 USD",
      validUntil: new Date(timer.clock.now().getTime() + 1),
    });
    timer.advance(day);

    await turn("Hello there");

    const [first, second] = promptOf(fake.calls[0]);
    expect(first?.role).toBe("user");
    expect(first?.content).toContain("{{price.haircut}}");
    expect(first?.content).toContain("45 USD");
    expect(first?.content).toContain("{{hours.week}}");
    expect(first?.content).not.toContain("99 USD");
    expect(first?.content).not.toContain("Hello there");
    expect(second?.content).toContain("Hello there");
  });

  it("keeps the system text the same when a fact changes, so the Release's cached prefix holds", async () => {
    const { rpc, turn, fake } = await serving([quiet(), quiet()]);
    const added = await rpc.representative.factAdd(price);

    await turn("One");
    await rpc.representative.factEdit(priceEdit(added.id, "60 USD"));
    await turn("Two");

    const [before, after] = fake.calls;
    expect(JSON.stringify(before)).toContain("45 USD");
    expect(JSON.stringify(before?.systemPrompts)).not.toContain("45 USD");
    expect(promptOf(after)[0]?.content).toContain("60 USD");
    expect(after?.systemPrompts).toEqual(before?.systemPrompts);
  });

  it("lists no more facts than fit, and says so; a key past the limit still inserts", async () => {
    const { rpc, turn, sent, fake } = await serving([
      replies({ text: "{{note.z}}", kind: "answer" }),
      quiet(),
    ]);
    for (let index = 0; index < 51; index += 1) {
      await rpc.representative.factAdd({
        key: `note.${String(index).padStart(2, "0")}`,
        type: "text",
        topic: "General",
        value: "x".repeat(2_000),
      });
    }
    await rpc.representative.factAdd({
      key: "note.z",
      type: "text",
      topic: "General",
      value: "The last.",
    });

    await turn();

    const first = String(promptOf(fake.calls[0])[0]?.content);
    expect(first).toContain("More facts are in effect");
    expect(first).not.toContain("The last.");
    expect(first.length).toBeLessThan(factsPromptChars + 10_000);
    expect((await sent())[0]?.text).toBe("The last.");
  });

  it("lists only the owner's own facts, never another owner's", async () => {
    const other = await serving([quiet()]);
    await other.rpc.representative.factAdd(price);
    const { turn, fake } = await serving([quiet()]);

    await turn("Hello there");

    // The Customer's message, the facts (the test Customer's owner has one, on the promoted topic),
    // the topics to label a reply with, then code's word on who sent it.
    expect(promptOf(fake.calls[0])).toHaveLength(4);
    expect(promptOf(fake.calls[0])[1]?.content).toContain("Hello there");
    expect(JSON.stringify(fake.calls[0]?.messages)).toContain(autoFact.key);
    expect(JSON.stringify(fake.calls[0]?.messages)).not.toContain("45 USD");
  });
});

describe("a test conversation", () => {
  async function tested(
    rounds: Round[],
    expectations: Expectation[],
    facts: Array<{ key: string; type: "text"; topic: string; value: string }> = [],
  ) {
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
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: "Answer questions.",
        model,
        tests: [{ name: "Price", message: "How much?", expect: expectations }],
      },
    });
    await rpc.representative.factAdd(price);
    for (const fact of facts) await rpc.representative.factAdd(fact);
    await rpc.representative.runTests({ id });
    await expect
      .poll(async () => {
        const { tests } = await rpc.representative.get({ id });
        return tests.every((test) => test.status !== "queued" && test.status !== "running");
      }, poll)
      .toBe(true);
    const { tests } = await rpc.representative.get({ id });
    return { result: tests[0]!, fake, userId: user.id };
  }

  it("inserts the value, and checks and shows what was sent, reaching nothing real", async () => {
    const { result, userId } = await tested(
      [answers("It is {{price.haircut}}."), quiet()],
      [
        { kind: "said", text: "45 USD" },
        { kind: "not_said", text: "price.haircut" },
      ],
    );

    expect(result.status).toBe("passed");
    expect(result.transcript).toEqual([
      { role: "customer", text: "How much?" },
      {
        role: "representative",
        text: "It is 45 USD.",
        reply: { kind: "answer", sources: [{ type: "fact", key: "price.haircut" }] },
      },
    ]);
    expect(
      await getTestDb()
        .select()
        .from(representativeCustomer)
        .where(eq(representativeCustomer.userId, userId)),
    ).toEqual([]);
  });

  it("passes cited for the fact a reply rested on, and fails it for another", async () => {
    const { result } = await tested(
      [answers("It is {{price.haircut}}."), quiet()],
      [
        { kind: "cited" },
        { kind: "cited", source: { type: "fact", key: "price.haircut" } },
        { kind: "cited", source: { type: "fact", key: "price.shave" } },
      ],
    );

    expect(result.status).toBe("failed");
    expect(result.checks.map((check) => check.passed)).toEqual([true, true, false]);
    expect(result.checks[2]?.detail).toBe(
      "It never cited the fact price.shave. It cited the fact price.haircut.",
    );
  });

  it("fails cited for a reply that cited nothing", async () => {
    const { result } = await tested(
      [replies({ text: "Hello!", kind: "small_talk" }), quiet()],
      [{ kind: "cited" }],
    );

    expect(result.checks).toMatchObject([{ passed: false, detail: "It cited no source." }]);
  });

  it("shows a test conversation's reply with its kind and sources", async () => {
    const { result } = await tested(
      [answers("It is {{price.haircut}}."), quiet()],
      [{ kind: "replied" }],
    );

    expect(result.transcript.at(-1)).toEqual({
      role: "representative",
      text: "It is 45 USD.",
      reply: { kind: "answer", sources: [{ type: "fact", key: "price.haircut" }] },
    });
  });

  it("counts a reply as sent however much its facts hold, as a live Turn would", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    const { result, fake } = await tested(
      [replies({ text: keys.map((key) => `{{${key}}}`).join(" "), kind: "answer" }), quiet()],
      [{ kind: "replied" }, { kind: "said", text: "eeee" }],
      keys.map((key) => ({
        key,
        type: "text" as const,
        topic: "General",
        value: key.repeat(1_900),
      })),
    );

    expect(result.status).toBe("passed");
    expect(answersIn(fake.calls[1])[0]).toBe(JSON.stringify({ sent: true }));
  });

  it("refuses as a live Turn does: a refused reply was never sent", async () => {
    const { result, fake } = await tested(
      [replies({ text: "It is {{price.beard}}.", kind: "answer" }), quiet()],
      [{ kind: "cited" }],
    );

    expect(result.status).toBe("failed");
    expect(answersIn(fake.calls[1])[0]).toContain("price.beard");
  });
});
