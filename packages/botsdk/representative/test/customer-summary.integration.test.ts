import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job, jobEvent, usage, userCredentials } from "@botsdk/bot/storage";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { answersOnce, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import {
  createFakeAdapter,
  round,
  runError,
  text,
  toolCall,
  withUsage,
} from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import {
  representativeThreadMessage,
  representativeCustomerSummary,
} from "../src/server/db/schema";
import { threadIdleJobName, threadIdleMs } from "../src/server/idle";
import { handOffMessage } from "../src/server/replies";
import { customerSummaryJobName, profileOperationsMarker } from "../src/server/customer-summary";
import { isSummaryPass } from "./summary-pass";

/*
 * A closed thread's summary (ticket #1279): a thread driven closed by a real runner on a fake clock
 * over real Postgres, with a fake Model, read through the owner's API.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const day = 24 * 60 * 60_000;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const ban = { on: false };
afterEach(() => {
  ban.on = false;
});

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance on a fake clock, whose Model answers Turns quietly and the pass from `pass`. */
async function instance({
  pass = [() => round(text("Asked about opening hours; told 9 to 5."))],
  draftModel = model,
  turnRounds = [],
}: {
  pass?: Array<() => ReturnType<typeof round>>;
  draftModel?: string | null;
  turnRounds?: Round[];
} = {}) {
  const passRounds = [...pass];
  const turns = [...turnRounds];
  const reply: Round = (options) => {
    if (isSummaryPass(options)) return (passRounds.shift() ?? pass.at(-1)!)();
    const next = turns.shift();
    if (!next) return answersOnce(options);
    return typeof next === "function" ? next(options) : next;
  };
  const fake = createFakeAdapter({ rounds: Array.from({ length: 40 }, () => reply) });
  const timer = fakeJobClock(new Date());
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    users: { isBlocked: async () => ban.on },
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
    draft: { jobText: "Answer questions.", model: draftModel },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const say = (message: string, externalId = "+15550001") =>
    testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      message,
      externalId,
    });
  const passTime = (ms: number) => {
    timer.advance(ms);
    timer.tick();
  };
  const passCalls = () => fake.calls.filter(isSummaryPass);
  const customerOf = async (externalId = "+15550001") => {
    const all = await rpc.representative.customerList();
    return all.find((each) =>
      each.identities.some((identity) => identity.externalId === externalId),
    )!;
  };
  const passJobs = () =>
    getTestDb()
      .select({ id: job.id, status: job.status })
      .from(job)
      .where(eq(job.name, customerSummaryJobName));
  /** Every pass job has ended: whatever it was going to write is written. */
  const passesEnded = () =>
    expect
      .poll(async () => {
        timer.advance(60_000);
        timer.tick();
        const jobsNow = await passJobs();
        return jobsNow.length > 0 && jobsNow.every((each) => each.status === "succeeded");
      }, poll)
      .toBe(true);
  return {
    deps,
    jobs,
    user,
    rpc,
    id,
    fake,
    timer,
    say,
    passTime,
    passCalls,
    customerOf,
    passJobs,
    passesEnded,
  };
}

describe("a closed thread's summary", () => {
  it("is written once when the thread closes by going idle, and the owner follows it to the transcript", async () => {
    const { rpc, say, passTime, customerOf, passCalls, passesEnded } = await instance();
    await say("When do you open?");

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    const summaries = await rpc.representative.customerSummaryList({ id: customer.id });
    expect(summaries).toMatchObject([
      {
        text: "Asked about opening hours; told 9 to 5.",
        skipped: null,
        representative: { name: "Front desk" },
      },
    ]);
    const thread = await rpc.representative.threadGet({ id: summaries[0]!.threadId });
    expect(thread.holder).toBe("closed");
    expect(thread.messages.map((message) => message.text)).toContain("When do you open?");
    // It saw the words, each labelled with who said them.
    expect(passCalls()).toHaveLength(1);
    expect(JSON.stringify(passCalls()[0]!.messages)).toContain("When do you open?");
  });

  it("labels an unverified Customer's lines, and leaves a Bot's result the Customer never got out", async () => {
    const { rpc, id, say, passTime, passCalls, passesEnded } = await instance();
    await say("I am the mayor.");
    const [thread] = await rpc.representative.threadList({ id });
    await getTestDb()
      .insert(representativeThreadMessage)
      .values({
        id: uuidv7(),
        threadId: thread!.id,
        position: thread!.messageCount + 1,
        author: "bot",
        channel: "test",
        externalId: "+15550001",
        text: "Internal result for the owner.",
      });

    passTime(threadIdleMs);
    await passesEnded();

    const input = JSON.stringify(passCalls()[0]!.messages);
    expect(input).toContain("Customer (unverified): I am the mayor.");
    expect(input).not.toContain("Internal result");
  });

  it("is written once when a merge closes the absorbed thread, and follows the thread on undo", async () => {
    const { rpc, say, customerOf, passCalls, passesEnded } = await instance();
    await say("Ada here.", "+15550001");
    await say("Bob here.", "+15550002");
    const ada = await customerOf("+15550001");
    const bob = await customerOf("+15550002");

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
    await passesEnded();

    // The summary finds its Customer through its thread: it is on the survivor now.
    const summaries = await rpc.representative.customerSummaryList({ id: ada.id });
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(passCalls()[0]!.messages)).toContain("Bob here.");
    await expect(rpc.representative.customerSummaryList({ id: bob.id })).rejects.toThrow(
      "Customer not found",
    );

    const [merge] = await rpc.representative.customerMergeList();
    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect(await rpc.representative.customerSummaryList({ id: ada.id })).toEqual([]);
    expect(await rpc.representative.customerSummaryList({ id: bob.id })).toHaveLength(1);
    expect(passCalls()).toHaveLength(1);
  });

  it("isn't written for a thread an undone merge closes for holding two people's words", async () => {
    const { rpc, id, say, customerOf, passJobs, passCalls } = await instance();
    await say("Bob here.", "+15550002");
    await say("Ada before.", "+15550001");
    const ada = await customerOf("+15550001");
    const bob = await customerOf("+15550002");
    const threads = await rpc.representative.threadList({ id });
    const adas = threads.find((thread) => thread.customer.id === ada.id)!;
    await rpc.representative.threadTakeOver({ id: adas.id });
    await rpc.representative.customerMerge({ id: ada.id, intoId: bob.id });
    const before = (await passJobs()).length;
    await say("Ada in the merge.", "+15550001");
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    expect((await rpc.representative.threadList({ id })).map((thread) => thread.holder)).toContain(
      "closed",
    );
    expect((await passJobs()).length).toBe(before);
    expect(JSON.stringify(passCalls())).not.toContain("Ada in the merge.");
  });

  it("doesn't write a second one when the pass is retried, or queued again", async () => {
    const { jobs, rpc, id, say, passTime, passJobs, customerOf, passCalls, passesEnded } =
      await instance({
        pass: [
          () => round(runError("The Provider is down")),
          () => round(text("Second try worked.")),
        ],
      });
    await say("Hello");

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    const summaries = await rpc.representative.customerSummaryList({ id: customer.id });
    expect(summaries.map((summary) => summary.text)).toEqual(["Second try worked."]);
    expect(passCalls()).toHaveLength(2);

    // A pass that runs again finds the summary before it calls the Model, even with a Bot's result
    // arriving after close.
    const [closed] = await rpc.representative.threadList({ id });
    await getTestDb()
      .insert(representativeThreadMessage)
      .values({
        id: uuidv7(),
        threadId: summaries[0]!.threadId,
        position: closed!.messageCount + 1,
        author: "bot",
        channel: "test",
        externalId: "+15550001",
        text: "A late result.",
      });
    await getTestDb().transaction((tx) =>
      jobs.enqueueIn(tx, customerSummaryJobName, { threadId: summaries[0]!.threadId }),
    );
    await expect
      .poll(async () => {
        passTime(1_000);
        const ended = await passJobs();
        return ended.filter((each) => each.status === "succeeded").length;
      }, poll)
      .toBe(2);

    expect(passCalls()).toHaveLength(2);
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toHaveLength(1);
  });

  it("is kept to the Model's reply in the job's Checkpoints: no Customer's words", async () => {
    const { say, passTime, passesEnded, passJobs } = await instance();
    await say("My secret words.");

    passTime(threadIdleMs);
    await passesEnded();

    const events = await getTestDb()
      .select({ result: jobEvent.result })
      .from(jobEvent)
      .where(
        inArray(
          jobEvent.jobId,
          (await passJobs()).map((each) => each.id),
        ),
      );
    expect(JSON.stringify(events)).toContain("Asked about opening hours");
    expect(JSON.stringify(events)).not.toContain("My secret words.");
  });

  it("isn't written for a thread the owner holds", async () => {
    const { rpc, id, say, passTime, passJobs, passCalls, customerOf } = await instance();
    await say("Hello");
    const [listed] = await rpc.representative.threadList({ id });
    await rpc.representative.threadTakeOver({ id: listed!.id });

    passTime(30 * day);
    await expect
      .poll(async () => (await idleChecks()).some((check) => check.status === "succeeded"), poll)
      .toBe(true);

    expect((await rpc.representative.threadList({ id }))[0]?.holder).toBe("owner");
    expect(await passJobs()).toEqual([]);
    expect(passCalls()).toEqual([]);
    const customer = await customerOf();
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toEqual([]);
  });

  it("isn't written for a thread waiting on code's hand-off", async () => {
    const guess = () =>
      round(
        toolCall({
          name: "reply",
          input: { topic: "general", text: "It is 10 USD.", kind: "answer" },
        }),
      );
    const { rpc, id, say, passTime, passJobs, passCalls } = await instance({
      turnRounds: [guess(), guess()],
    });
    await say("How much?");
    await expect
      .poll(async () => {
        const [thread] = await rpc.representative.threadList({ id });
        return (
          thread && (await rpc.representative.threadGet({ id: thread.id })).messages.at(-1)?.text
        );
      }, poll)
      .toBe(handOffMessage);

    passTime(30 * day);
    await expect
      .poll(async () => (await idleChecks()).some((check) => check.status === "succeeded"), poll)
      .toBe(true);

    expect((await rpc.representative.threadList({ id }))[0]?.holder).toBe("representative");
    expect(await passJobs()).toEqual([]);
    expect(passCalls()).toEqual([]);
  });

  it("runs no pass for a Release that names no Model, and records the skip", async () => {
    const { rpc, say, passTime, customerOf, passCalls, passesEnded, user } = await instance({
      draftModel: null,
    });
    await say("Hello");

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toMatchObject([
      { text: null, skipped: "no_model" },
    ]);
    expect(passCalls()).toEqual([]);
    expect(await passSpend(user.id)).toEqual([]);
  });

  it("records a skip when the Release's Model can't run now, with no call", async () => {
    const { rpc, say, passTime, customerOf, passCalls, passesEnded, user } = await instance();
    await say("Hello");
    await getTestDb().delete(userCredentials).where(eq(userCredentials.userId, user.id));

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toMatchObject([
      { text: null, skipped: "model_unavailable" },
    ]);
    expect(passCalls()).toEqual([]);
  });

  it("makes no Model call during the owner's Ban, and records a skip", async () => {
    const { rpc, say, passTime, customerOf, passCalls, passesEnded } = await instance();
    await say("Hello");
    ban.on = true;

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toMatchObject([
      { text: null, skipped: "model_unavailable" },
    ]);
    expect(passCalls()).toEqual([]);
  });

  it("records a skip when the Model replies with nothing", async () => {
    const { rpc, say, passTime, customerOf, passesEnded } = await instance({
      pass: [() => round(text("  "))],
    });
    await say("Hello");

    passTime(threadIdleMs);
    await passesEnded();

    const customer = await customerOf();
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toMatchObject([
      { text: null, skipped: "empty_reply" },
    ]);
  });

  it("records a skip when every try of the Model fails", async () => {
    const { rpc, say, passTime, customerOf, passCalls, passJobs, timer } = await instance({
      pass: [() => round(runError("The Provider is down"))],
    });
    await say("Hello");

    passTime(threadIdleMs);
    await expect
      .poll(async () => {
        timer.advance(60 * 60_000);
        timer.tick();
        return (await passJobs()).map((each) => each.status);
      }, poll)
      .toEqual(["failed"]);

    const customer = await customerOf();
    await expect
      .poll(() => rpc.representative.customerSummaryList({ id: customer.id }), poll)
      .toMatchObject([{ text: null, skipped: "model_failed" }]);
    expect(passCalls()).toHaveLength(3);
  });

  it("isn't written for a held thread a merge closes", async () => {
    const { rpc, id, say, customerOf, passJobs, passCalls } = await instance();
    await say("Ada here.", "+15550001");
    await say("Bob here.", "+15550002");
    const ada = await customerOf("+15550001");
    const bob = await customerOf("+15550002");
    const threads = await rpc.representative.threadList({ id });
    const bobs = threads.find((thread) => thread.customer.id === bob.id)!;
    await rpc.representative.threadTakeOver({ id: bobs.id });

    await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    expect((await rpc.representative.threadGet({ id: bobs.id })).holder).toBe("closed");
    expect(await passJobs()).toEqual([]);
    expect(passCalls()).toEqual([]);
  });

  it("records its spend under its own usage kind", async () => {
    const { say, passTime, passesEnded, user } = await instance({
      pass: [
        () =>
          withUsage(round(text("A summary.")), {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          }),
      ],
    });
    await say("Hello");

    passTime(threadIdleMs);
    await passesEnded();

    expect(await passSpend(user.id)).toMatchObject([
      { kind: "customer_memory", model, inputTokens: 10, outputTokens: 5 },
    ]);
  });

  it("can't be read by another owner, nor its transcript", async () => {
    const { deps, rpc, say, passTime, customerOf, passesEnded } = await instance();
    await say("Hello");
    passTime(threadIdleMs);
    await passesEnded();
    const customer = await customerOf();
    const [summary] = await rpc.representative.customerSummaryList({ id: customer.id });

    const theirs = chatRpc({ user: await insertUser(), deps });

    await expect(theirs.representative.customerSummaryList({ id: customer.id })).rejects.toThrow(
      "Customer not found",
    );
    await expect(theirs.representative.threadGet({ id: summary!.threadId })).rejects.toThrow(
      "Thread not found",
    );
  });

  it("is in the owner's export, and gone with the owner's delete", async () => {
    const { deps, say, passTime, passesEnded, user } = await instance();
    await say("Hello");
    passTime(threadIdleMs);
    await passesEnded();

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { customerSummaries: unknown };
    };
    expect(exported.representative.customerSummaries).toMatchObject([
      { text: "Asked about opening hours; told 9 to 5.", skipped: null },
    ]);

    await deleteUserData(deps, user.id);
    expect(
      await getTestDb()
        .select({ id: representativeCustomerSummary.id })
        .from(representativeCustomerSummary)
        .where(eq(representativeCustomerSummary.userId, user.id)),
    ).toEqual([]);
  });
});

const idleChecks = () =>
  getTestDb().select({ status: job.status }).from(job).where(eq(job.name, threadIdleJobName));

describe("a closed thread's profile values (ticket #1282)", () => {
  type Operation = { field: string; value: string; line: number };
  type Line = { author: "customer" | "representative" | "owner"; verified: boolean; text?: string };
  const sayings =
    "French German Ada Green Klingon Eve 1 High St, 2 Low St, 3 Mid St, Unverified St";

  const reply =
    (...operations: Operation[]) =>
    () =>
      round(text(`A summary.\n${profileOperationsMarker}\n${JSON.stringify(operations)}`));

  /** Replaces the thread's lines with these, by position, so each one's author and standing is known. */
  const setLines = async (threadId: string, lines: Line[]) => {
    await getTestDb()
      .delete(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, threadId));
    await getTestDb()
      .insert(representativeThreadMessage)
      .values(
        lines.map((line, index) => ({
          id: uuidv7(),
          threadId,
          position: index + 1,
          author: line.author,
          verified: line.verified,
          channel: "test",
          externalId: "+15550001",
          text: line.text ?? sayings,
        })),
      );
  };

  type World = Awaited<ReturnType<typeof instance>>;
  const profileOf = async (rpc: World["rpc"], id: string) =>
    (await rpc.representative.customerList()).find((each) => each.id === id)!.profile;

  /** Drives a thread to close with its lines set as given; the pass has run when this returns. */
  async function closed(operations: Operation[], lines: Line[]) {
    const world = await instance({ pass: [reply(...operations)] });
    await world.say("Hello");
    const [thread] = await world.rpc.representative.threadList({ id: world.id });
    await setLines(thread!.id, lines);
    world.passTime(threadIdleMs);
    await world.passesEnded();
    const customer = await world.customerOf();
    return { ...world, customer, profile: () => profileOf(world.rpc, customer.id) };
  }

  it("makes a verified Customer's statement confirmed, citing its source and date", async () => {
    const { profile } = await closed(
      [{ field: "language", value: "French", line: 1 }],
      [{ author: "customer", verified: true }],
    );

    expect(await profile()).toMatchObject([
      { field: "language", value: "French", source: "customer", status: "confirmed" },
    ]);
    expect((await profile())[0]!.recordedAt).toBeInstanceOf(Date);
  });

  it("leaves an unverified statement claimed", async () => {
    const { profile } = await closed(
      [{ field: "address", value: "1 High St", line: 1 }],
      [{ author: "customer", verified: false }],
    );

    expect(await profile()).toMatchObject([
      { field: "address", value: "1 High St", status: "claimed" },
    ]);
  });

  it("stores no time zone the gate couldn't read", async () => {
    const { profile } = await closed(
      [{ field: "time_zone", value: "Mars/Olympus", line: 1 }],
      [{ author: "customer", verified: false }],
    );

    expect(await profile()).toEqual([]);
  });

  it("lets no owner or Representative line make a value confirmed, whatever its row says", async () => {
    const { profile } = await closed(
      [
        { field: "language", value: "German", line: 1 },
        { field: "address", value: "2 Low St", line: 2 },
      ],
      [
        { author: "owner", verified: true },
        { author: "representative", verified: true },
      ],
    );

    expect(await profile()).toMatchObject([
      { field: "language", status: "claimed", source: "owner" },
      { field: "address", status: "claimed", source: "representative" },
    ]);
  });

  it("keeps a value claimed when the verified line it cites doesn't say it", async () => {
    const { profile } = await closed(
      [{ field: "address", value: "Evil St", line: 1 }],
      [{ author: "customer", verified: true, text: "Hello there" }],
    );

    expect(await profile()).toMatchObject([{ field: "address", status: "claimed" }]);
  });

  it("gives each value the status of its own cited line", async () => {
    const { profile } = await closed(
      [
        { field: "language", value: "French", line: 1 },
        { field: "address", value: "3 Mid St", line: 2 },
      ],
      [
        { author: "customer", verified: true },
        { author: "customer", verified: false },
      ],
    );

    const values = await profile();
    expect(values.find((each) => each.field === "language")?.status).toBe("confirmed");
    expect(values.find((each) => each.field === "address")?.status).toBe("claimed");
  });

  it("drops an operation citing a line that doesn't exist or naming a field that doesn't, and keeps the summary", async () => {
    const { rpc, customer, profile } = await closed(
      [
        { field: "language", value: "French", line: 9 },
        { field: "shoe_size", value: "42", line: 1 },
        { field: "name", value: "Ada", line: 1 },
      ],
      [{ author: "customer", verified: true }],
    );

    expect(await profile()).toMatchObject([{ field: "name", value: "Ada" }]);
    expect(await profile()).toHaveLength(1);
    expect(await rpc.representative.customerSummaryList({ id: customer.id })).toMatchObject([
      { text: "A summary." },
    ]);
  });

  it("writes an owner's own field by its name, and ignores a reply it can't read", async () => {
    const world = await instance({
      pass: [
        reply({ field: "Favourite colour", value: "Green", line: 1 }),
        () => round(text(`Another.\n${profileOperationsMarker}\nnot json`)),
      ],
    });
    const field = await world.rpc.representative.profileFieldAdd({ name: "Favourite colour" });
    await world.say("Hello");
    const [thread] = await world.rpc.representative.threadList({ id: world.id });
    await setLines(thread!.id, [{ author: "customer", verified: true }]);
    world.passTime(threadIdleMs);
    await world.passesEnded();
    const customer = await world.customerOf();
    expect(await profileOf(world.rpc, customer.id)).toMatchObject([
      { field: field.id, value: "Green", status: "confirmed" },
    ]);

    await world.say("Hi again", "+15550002");
    const other = await world.customerOf("+15550002");
    world.passTime(threadIdleMs);
    await expect
      .poll(async () => {
        world.passTime(60_000);
        return world.rpc.representative.customerSummaryList({ id: other.id });
      }, poll)
      .toMatchObject([{ text: "Another." }]);
    expect(await profileOf(world.rpc, other.id)).toEqual([]);
  });

  it("doesn't overwrite a confirmed owner value, nor a confirmed value with a claimed one", async () => {
    const world = await instance({
      pass: [
        reply(
          { field: "language", value: "Klingon", line: 1 },
          { field: "address", value: "Unverified St", line: 2 },
          { field: "name", value: "Eve", line: 1 },
        ),
      ],
    });
    await world.say("Hello");
    const customer = await world.customerOf();
    await world.rpc.representative.customerProfileSet({
      id: customer.id,
      field: "language",
      value: "English",
    });
    await world.rpc.representative.customerRename({ id: customer.id, name: "Ada" });
    const [thread] = await world.rpc.representative.threadList({ id: world.id });
    await setLines(thread!.id, [
      { author: "customer", verified: true },
      { author: "customer", verified: false },
    ]);
    world.passTime(threadIdleMs);
    await world.passesEnded();

    const values = await profileOf(world.rpc, customer.id);
    expect(values.find((each) => each.field === "language")).toMatchObject({
      value: "English",
      source: "owner",
    });
    expect(values.find((each) => each.field === "name")).toMatchObject({
      value: "Ada",
      source: "owner",
    });
    expect(values.find((each) => each.field === "address")).toMatchObject({
      value: "Unverified St",
      status: "claimed",
    });
  });

  it("gives a Representative's Turn no tool that writes memory", async () => {
    const { say, fake } = await instance();
    await say("Remember that I like tea.");

    // `read_customer_work` only reads, and live.
    const tools = fake.calls
      .flatMap((call) => (call.tools ?? []).map((tool) => tool.name))
      .filter((name) => name !== "read_customer_work");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((name) => /memory|profile|remember|customer/i.test(name))).toEqual([]);
  });
});

const passSpend = (userId: string) =>
  getTestDb()
    .select({
      kind: usage.kind,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.kind, "customer_memory")));
