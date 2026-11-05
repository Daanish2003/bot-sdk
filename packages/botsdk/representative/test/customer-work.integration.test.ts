import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { approveDrafts, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { customerSummaryMarker } from "../src/server/customer-summary";
import { threadIdleMs } from "../src/server/idle";
import {
  representativeHandOff,
  representativeProfileValue,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";

/*
 * A Representative reads a verified Customer's own work live (ticket #1284): from a fake Channel
 * through a Turn with a fake Model on real Postgres. Assignments and their hand-offs are rows the
 * test writes, since the read is the thing under test, not the hand-off.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const sameIdentity = { rule: "sameIdentity" } as const;
const phone = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const readsWork = () => round(toolCall({ name: "read_customer_work", input: {} }));
const cites = (text: string, assignmentId: string, quote: string) =>
  round(
    toolCall({
      name: "reply",
      input: {
        topic: "general",
        text,
        kind: "answer",
        sources: [{ type: "assignment", assignmentId, quote }],
      },
    }),
  );

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

async function instance(rounds: Round[]) {
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
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "read_customer_work"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  return { deps, fake, user, rpc, id, botId };
}
type Instance = Awaited<ReturnType<typeof instance>>;

const customer = (rpc: Instance["rpc"], externalId = phone) =>
  rpc.representative.customerCreate({ channel: "sms", externalId });

type Made = {
  /** For a reply that cites it: the rounds are scripted before the rows exist. */
  id?: string;
  status?: "open" | "working" | "blocked" | "done" | "failed" | "cancelled";
  forCustomer?: string;
  threadId?: string | null;
  customerId?: string | null;
};

/** An Assignment of the Bot and the hand-off that ties it to a Customer, as a Turn left them. */
async function assigned(world: Pick<Instance, "id" | "botId">, title: string, made: Made) {
  const status = made.status ?? "working";
  const ended = status === "done" || status === "failed";
  const at = new Date("2026-02-01");
  const id = made.id ?? uuidv7();
  await getTestDb()
    .insert(botAssignment)
    .values({
      id,
      assignedBotId: world.botId,
      title,
      instructions: `Private instructions for ${title}`,
      status,
      result: ended
        ? { outcome: `Private outcome of ${title}`, forCustomer: made.forCustomer }
        : null,
      createdAt: at,
      updatedAt: at,
      endedAt: ended ? at : null,
    });
  await getTestDb()
    .insert(representativeHandOff)
    .values({
      assignmentId: id,
      representativeId: world.id,
      threadId: made.threadId ?? null,
      customerId: made.customerId ?? null,
    });
  return id;
}

const ask = (world: Instance, message: string, verified = true) =>
  testCustomerTurn(world.deps, {
    representativeId: world.id,
    message,
    externalId: phone,
    channel: "sms",
    proof: verified ? sameIdentity : undefined,
  });

/** What the tools answered in the messages of Model call `call`. */
const answersAt = (fake: Instance["fake"], call: number) =>
  ((fake.calls[call]?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content))
    .join("\n");

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

describe("read_customer_work", () => {
  it("answers a verified Customer with the status of their work and what the Bot said for them", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    await assigned(world, "Open boiler job", { customerId: ada.id });
    await assigned(world, "Finished refund", {
      customerId: ada.id,
      status: "done",
      forCustomer: "Your refund of 20 is on its way.",
    });

    await ask(world, "Where is my work?");

    const answer = answersAt(world.fake, 1);
    expect(answer).toContain("Open boiler job");
    expect(answer).toContain("working");
    expect(answer).toContain("Finished refund");
    expect(answer).toContain("Your refund of 20 is on its way.");
  });

  it("never returns a result that is not for the Customer, nor the instructions", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    await assigned(world, "Internal audit", { customerId: ada.id, status: "done" });

    await ask(world, "Where is my work?");

    const answer = answersAt(world.fake, 1);
    expect(answer).toContain("Internal audit");
    expect(answer).not.toContain("Private outcome");
    expect(answer).not.toContain("Private instructions");
  });

  it("returns nothing of another Customer's work, or another owner's", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    const bob = await customer(world.rpc, "+15550002");
    await assigned(world, "Ada's job", { customerId: ada.id });
    await assigned(world, "Bob's job", { customerId: bob.id });
    // Another owner's Customer on the same address is a different Customer.
    const stranger = await insertUser();
    await saveCredentials(world.deps, stranger.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const theirs = chatRpc({ user: stranger, deps: world.deps });
    const theirBot = await theirs.bots.create({ name: "Theirs", model });
    const theirRep = await theirs.representative.create({ name: "Theirs", botId: theirBot.id });
    const theirCustomer = await customer(theirs);
    await assigned({ id: theirRep.id, botId: theirBot.id }, "Stranger's job", {
      customerId: theirCustomer.id,
    });

    await ask(world, "Where is my work?");

    const answer = answersAt(world.fake, 1);
    expect(answer).toContain("Ada's job");
    expect(answer).not.toContain("Bob's job");
    expect(answer).not.toContain("Stranger's job");
  });

  it("gives an unverified sender nothing", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    await assigned(world, "Ada's job", { customerId: ada.id });

    await ask(world, "Where is my work?", false);

    expect(answersAt(world.fake, 1)).not.toContain("Ada's job");
    expect(answersAt(world.fake, 1)).toContain("work");
  });

  it("still reads work delivered earlier, whose hand-off has lost its thread", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    await assigned(world, "Delivered refund", {
      customerId: ada.id,
      threadId: null,
      status: "done",
      forCustomer: "Refund sent last week.",
    });

    await ask(world, "Where is my refund?");

    expect(answersAt(world.fake, 1)).toContain("Refund sent last week.");
  });

  it("reads work whose hand-off names a thread of the Customer and no Customer", async () => {
    const world = await instance([readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    const threadId = uuidv7();
    await getTestDb().insert(representativeThread).values({
      id: threadId,
      customerId: ada.id,
      representativeId: world.id,
      state: "closed",
      lastChannel: "sms",
      lastExternalId: phone,
      messageCount: 0,
    });
    await assigned(world, "Old thread job", { threadId });

    await ask(world, "Where is my work?");

    expect(answersAt(world.fake, 1)).toContain("Old thread job");
  });

  it("follows a merge for work delivered before it, and gives it back when the merge is undone", async () => {
    const world = await instance([readsWork(), quiet(), readsWork(), quiet()]);
    const ada = await customer(world.rpc);
    const bob = await customer(world.rpc, "+15550002");
    // Bob's delivered work: its thread is gone and its Customer is still Bob, as a merge leaves it.
    await assigned(world, "Bob's delivered job", {
      customerId: bob.id,
      status: "done",
      forCustomer: "Bob's parcel left on Friday.",
    });
    await world.rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });

    await ask(world, "Where is my work?");
    expect(answersAt(world.fake, 1)).toContain("Bob's parcel left on Friday.");

    const [merge] = await world.rpc.representative.customerMergeList();
    await world.rpc.representative.customerMergeUndo({ id: merge!.id });
    await ask(world, "And now?");
    expect(answersAt(world.fake, 3)).not.toContain("Bob's parcel");
  });
});

describe("a reply citing work", () => {
  const forCustomer = "Your refund of 20 is on its way.";

  it("goes through on an exact quote of what the tool answered this Turn", async () => {
    const id = uuidv7();
    const world = await instance([
      readsWork(),
      cites("Your refund is on its way.", id, "refund of 20"),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    await assigned(world, "Finished refund", {
      id,
      customerId: ada.id,
      status: "done",
      forCustomer,
    });

    await ask(world, "Where is my refund?");
    await approveDrafts(world.rpc);

    expect(await sent(world.id)).toEqual([
      {
        text: "Your refund is on its way.",
        sources: [{ type: "assignment", assignmentId: id, quote: "refund of 20" }],
      },
    ]);
  });

  it("is refused for a quote the tool did not answer", async () => {
    const id = uuidv7();
    const world = await instance([
      readsWork(),
      cites("Your refund of 99 is on its way.", id, "refund of 99"),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    await assigned(world, "Finished refund", {
      id,
      customerId: ada.id,
      status: "done",
      forCustomer,
    });

    await ask(world, "Where is my refund?");

    expect((await sent(world.id)).map((message) => message.text)).not.toContain(
      "Your refund of 99 is on its way.",
    );
    expect(answersAt(world.fake, 2)).toMatch(/Nothing was sent/);
  });

  it("is refused for work the tool was never called for this Turn", async () => {
    const id = uuidv7();
    const world = await instance([
      cites("Your refund is on its way.", id, "refund of 20"),
      quiet(),
    ]);
    const ada = await customer(world.rpc);
    await assigned(world, "Finished refund", {
      id,
      customerId: ada.id,
      status: "done",
      forCustomer,
    });

    await ask(world, "Where is my refund?");

    expect(answersAt(world.fake, 1)).toMatch(/Nothing was sent/);
  });
});

describe("after the thread closes", () => {
  it("has the pass write no live status or result into the summary or the profile", async () => {
    const day = 24 * 60 * 60_000;
    const forCustomer = "Parcel 4471 is ready at the depot.";
    const turns = [readsWork(), round(text("Let me check on that."))];
    const reply: Round = (options) => {
      if (JSON.stringify(options.systemPrompts ?? []).includes(customerSummaryMarker)) {
        return round(text("Asked where their work is."));
      }
      return turns.shift() ?? round();
    };
    const fake = createFakeAdapter({ rounds: Array.from({ length: 20 }, () => reply) });
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
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model });
    const { id } = await rpc.representative.create({ name: "Front desk", botId });
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions.", model, tools: ["reply", "read_customer_work"] },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    const ada = await customer(rpc);
    await assigned({ id, botId }, "Parcel job", {
      customerId: ada.id,
      status: "done",
      forCustomer,
    });

    await testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      message: "Where is my parcel?",
      externalId: phone,
      channel: "sms",
      proof: sameIdentity,
    });
    expect(JSON.stringify(fake.calls.map((call) => call.messages))).toContain(forCustomer);
    timer.advance(threadIdleMs + day);
    timer.tick();

    await expect
      .poll(async () => (await rpc.representative.customerSummaryList({ id: ada.id })).length, {
        timeout: 10_000,
      })
      .toBe(1);
    const passCalls = fake.calls.filter((call) =>
      JSON.stringify(call.systemPrompts ?? []).includes(customerSummaryMarker),
    );
    expect(passCalls).toHaveLength(1);
    expect(JSON.stringify(passCalls[0]!.messages)).not.toContain(forCustomer);
    const summaries = await rpc.representative.customerSummaryList({ id: ada.id });
    expect(JSON.stringify(summaries)).not.toContain("Parcel");
    expect(
      await getTestDb()
        .select({ value: representativeProfileValue.value })
        .from(representativeProfileValue)
        .where(eq(representativeProfileValue.customerId, ada.id)),
    ).toEqual([]);
  });
});
