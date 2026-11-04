import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { claimPastDeliveries, startTestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { handOffMessage } from "../src/server/replies";
import { representativeThread, representativeThreadMessage } from "../src/server/db/schema";

/*
 * A reply that can't confirm, and the owner's Gaps (ticket #1263): from a fake Channel through a
 * Representative Turn, with a fake Model on real Postgres. The clock is the test's, and it runs the
 * jobs by hand.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (input: object) => round(toolCall({ name: "reply", input }));
const cantConfirm = (question: string, text = "I can't confirm that. Shall I hand it off?") =>
  replies({ text, kind: "cant_confirm", question });
const answers = (text: string, key = "price.haircut") =>
  replies({ text, kind: "answer", sources: [{ type: "fact", key }] });

const price = { key: "price.haircut", type: "money", topic: "Prices", value: "45 USD" } as const;
const priceDates = { validFrom: null, validUntil: null };

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

async function serving(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
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
    adapterFor: () => fake.adapter,
    memory: false,
  });
  const running: Array<Promise<void>> = [];

  /** An owner with an enabled Representative on this SDK. */
  const owner = async () => {
    const user = await insertUser();
    await saveCredentials(deps!, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const rpc = chatRpc({ user, deps: deps! });
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    return {
      user,
      rpc,
      id,
      /** Sends the Customer's message and runs its Turn to the end. */
      turn: async (message = "Do you do weddings?") => {
        await startTestCustomerTurn(deps!, {
          representativeId: id,
          externalId: "+15550001",
          message,
        });
        timer.advance(500);
        const claimed = await claimPastDeliveries(jobs, timer.clock.now(), {
          respectRunAfter: true,
        });
        if (claimed) running.push(jobs.runClaimed(claimed, {}));
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
    };
  };
  return { fake, deps, owner };
}

/** What the tools answered in the Model's call. */
const answersIn = (call: { messages: unknown } | undefined) =>
  ((call?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content));

describe("a reply that can't confirm", () => {
  it("reaches the Customer with no source, and logs a Gap with its Representative", async () => {
    const { owner } = await serving([cantConfirm("Do you do weddings?"), quiet()]);
    const { rpc, id, turn, sent } = await owner();

    await turn();

    expect(await sent()).toEqual([
      { text: "I can't confirm that. Shall I hand it off?", kind: "cant_confirm", sources: [] },
    ]);
    expect(await rpc.representative.gapList()).toEqual([
      expect.objectContaining({ question: "Do you do weddings?", count: 1, representativeId: id }),
    ]);
  });

  it("refuses one with no question, sends nothing and logs no Gap", async () => {
    const { owner, fake } = await serving([
      replies({ text: "I can't confirm that.", kind: "cant_confirm" }),
      quiet(),
    ]);
    const { rpc, turn, sent } = await owner();

    await turn();

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/question/);
    expect(await rpc.representative.gapList()).toEqual([]);
  });

  it("raises the count for the same question in another case, spacing or punctuation", async () => {
    const { owner } = await serving([
      cantConfirm("Do you do weddings?"),
      quiet(),
      cantConfirm("  do YOU   do weddings "),
      quiet(),
      cantConfirm("Do you do weddings?!"),
      quiet(),
      cantConfirm("Do you do funerals?"),
      quiet(),
    ]);
    const { rpc, turn } = await owner();

    await turn();
    await turn("again");
    await turn("and again");
    await turn("another");

    const gaps = await rpc.representative.gapList();
    expect(gaps.map(({ question, count }) => ({ question, count }))).toEqual([
      { question: "Do you do funerals?", count: 1 },
      { question: "Do you do weddings?", count: 3 },
    ]);
  });

  it("keeps two owners' Gaps apart, and shows each only its own", async () => {
    const { owner } = await serving([
      cantConfirm("Do you do weddings?"),
      quiet(),
      cantConfirm("Do you do weddings?"),
      quiet(),
    ]);
    const first = await owner();
    const second = await owner();

    await first.turn();
    await second.turn();

    const [mine] = await first.rpc.representative.gapList();
    const [theirs] = await second.rpc.representative.gapList();
    expect(mine).toMatchObject({ count: 1, representativeId: first.id });
    expect(theirs).toMatchObject({ count: 1, representativeId: second.id });
    expect(mine!.id).not.toBe(theirs!.id);
    // Another owner's Gap is not found, to dismiss or to answer.
    await expect(second.rpc.representative.gapDismiss({ id: mine!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      second.rpc.representative.gapToFact({ id: mine!.id, ...price, ...priceDates }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await first.rpc.representative.gapList()).toHaveLength(1);
    expect(await first.rpc.representative.factList()).toEqual([]);
  });

  it("keeps the question as the plain text it was, markup and all", async () => {
    const { owner } = await serving([cantConfirm("<b>weddings</b> {{price.haircut}}?"), quiet()]);
    const { rpc, turn } = await owner();

    await turn();

    expect((await rpc.representative.gapList())[0]?.question).toBe(
      "<b>weddings</b> {{price.haircut}}?",
    );
  });
});

describe("dismissing a Gap", () => {
  it("takes it off the list, and the same question asked again starts a new Gap", async () => {
    const { owner } = await serving([
      cantConfirm("Do you do weddings?"),
      quiet(),
      cantConfirm("Do you do weddings?"),
      quiet(),
    ]);
    const { rpc, turn } = await owner();
    await turn();
    const [first] = await rpc.representative.gapList();

    await rpc.representative.gapDismiss({ id: first!.id });

    expect(await rpc.representative.gapList()).toEqual([]);
    await expect(rpc.representative.gapDismiss({ id: first!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await turn("again");

    const gaps = await rpc.representative.gapList();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ question: "Do you do weddings?", count: 1 });
    expect(gaps[0]!.id).not.toBe(first!.id);
  });
});

describe("turning a Gap into a fact", () => {
  it("creates the fact and closes the Gap, and the next answer can quote the fact", async () => {
    const { owner } = await serving([
      cantConfirm("How much is a haircut?"),
      quiet(),
      answers("A haircut is {{price.haircut}}."),
      quiet(),
    ]);
    const { rpc, turn, sent } = await owner();
    await turn("How much is a haircut?");
    const [gap] = await rpc.representative.gapList();

    const made = await rpc.representative.gapToFact({ id: gap!.id, ...price, ...priceDates });

    expect(made).toMatchObject({ key: "price.haircut", value: "45 USD", inEffect: true });
    expect(await rpc.representative.gapList()).toEqual([]);
    expect(await rpc.representative.factList()).toHaveLength(1);
    const log = await rpc.representative.factLog();
    expect(log.map(({ key, action }) => ({ key, action }))).toEqual([
      { key: "price.haircut", action: "add" },
    ]);

    await turn("How much is a haircut?");

    expect((await sent()).at(-1)).toMatchObject({ text: "A haircut is 45 USD.", kind: "answer" });
  });

  it("leaves the Gap open when the fact is refused, and makes no fact for a Gap that is gone", async () => {
    const { owner } = await serving([cantConfirm("How much is a haircut?"), quiet()]);
    const { rpc, turn } = await owner();
    await rpc.representative.factAdd(price);
    await turn();
    const [gap] = await rpc.representative.gapList();

    await expect(
      rpc.representative.gapToFact({ id: gap!.id, ...price, ...priceDates }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rpc.representative.gapList()).toHaveLength(1);

    await rpc.representative.gapDismiss({ id: gap!.id });
    await expect(
      rpc.representative.gapToFact({ id: gap!.id, ...price, ...priceDates, key: "price.beard" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await rpc.representative.factList()).toHaveLength(1);
  });
});

describe("a test conversation", () => {
  it("logs no Gap", async () => {
    const fake = createFakeAdapter({ rounds: [cantConfirm("Do you do weddings?"), quiet()] });
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
        tests: [
          { name: "Weddings", message: "Do you do weddings?", expect: [{ kind: "replied" }] },
        ],
      },
    });
    await rpc.representative.runTests({ id });
    await expect
      .poll(async () => {
        const { tests } = await rpc.representative.get({ id });
        return tests.every((test) => test.status !== "queued" && test.status !== "running");
      }, poll)
      .toBe(true);

    const { tests } = await rpc.representative.get({ id });
    expect(tests[0]).toMatchObject({ status: "passed" });
    expect(await rpc.representative.gapList()).toEqual([]);
  });
});

describe("the owner's data", () => {
  it("exports every Gap, and deletes them with the account", async () => {
    const { owner, deps } = await serving([
      cantConfirm("Do you do weddings?"),
      quiet(),
      cantConfirm("Do you do funerals?"),
      quiet(),
    ]);
    const { rpc, turn, user } = await owner();
    await turn();
    await turn("and?");
    const [funerals] = await rpc.representative.gapList();
    await rpc.representative.gapDismiss({ id: funerals!.id });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { gaps: Array<{ question: string; count: number; status: string }> };
    };
    expect(exported.representative.gaps).toMatchObject([
      { question: "Do you do weddings?", count: 1, status: "open" },
      { question: "Do you do funerals?", status: "dismissed" },
    ]);

    await deleteUserData(deps, user.id);
    const after = (await exportUserData(deps, user.id)) as unknown as typeof exported;
    expect(after.representative.gaps).toEqual([]);
  });
});
