import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { job } from "@botsdk/bot/storage";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text } from "@botsdk/testing/fake-adapter";
import type { TextOptions } from "@tanstack/ai";
import { representative } from "../src";
import { representativeFactProposal } from "../src/server/db/schema";
import {
  customerSummaryJobName,
  customerSummaryMarker,
  lessonMarker,
  profileOperationsMarker,
} from "../src/server/customer-summary";
import { threadIdleMs } from "../src/server/idle";

/*
 * A lesson the pass proposes from a closed thread (ticket #1289): a thread driven closed by a real
 * runner on a fake clock over real Postgres, with a fake Model, read through the owner's API. It
 * reaches the owner as an Approval on the Facts page, with no Bot in it.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const poll = { timeout: 10_000 };
const newline = String.fromCharCode(10);

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const isPassCall = (options: TextOptions) =>
  JSON.stringify(options.systemPrompts ?? []).includes(customerSummaryMarker);

const lesson = {
  key: "policy.same-day",
  type: "text",
  topic: "Policies",
  value: "Customers who ask about same-day repairs want a firm quote before booking.",
};

/** What the pass replies with a lesson after its summary. */
const replying = (tail: string) => () => round(text(`A summary.\n${lessonMarker}\n${tail}`));

async function instance(pass: () => ReturnType<typeof round>) {
  const reply = (options: TextOptions) => (isPassCall(options) ? pass() : round());
  const fake = createFakeAdapter({ rounds: Array.from({ length: 40 }, () => reply) });
  const timer = fakeJobClock(new Date());
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
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
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer.", model } });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const { id: botId } = await rpc.bots.create({ name: "Ada", model });
  const customerOf = async () => (await rpc.representative.customerList())[0]!;
  const passesEnded = () =>
    expect
      .poll(async () => {
        timer.advance(60_000);
        timer.tick();
        const rows = await getTestDb()
          .select({ status: job.status })
          .from(job)
          .where(eq(job.name, customerSummaryJobName));
        return rows.length > 0 && rows.every((each) => each.status === "succeeded");
      }, poll)
      .toBe(true);
  /** A Customer writes, then goes quiet, and the pass has run when this returns. */
  const closeThread = async (before?: () => Promise<void>) => {
    await testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      message: "Can you fix it today?",
      externalId: "+15550001",
    });
    await before?.();
    timer.advance(threadIdleMs);
    timer.tick();
    await passesEnded();
  };
  const botMessages = async () => (await rpc.bots.get({ botId })).messages.length;
  return { deps, user, rpc, botId, customerOf, closeThread, botMessages };
}

describe("a lesson from a closed thread", () => {
  it("shows on the facts page with no Bot, and approving makes a Published fact the pass proposed", async () => {
    const { rpc, closeThread, botMessages } = await instance(replying(JSON.stringify(lesson)));
    const before = await botMessages();
    await closeThread();

    const [proposal] = await rpc.representative.factProposals();
    expect(proposal).toMatchObject({
      key: lesson.key,
      botId: null,
      botName: null,
      current: null,
      proposed: { type: "text", topic: "Policies", value: lesson.value },
    });
    expect(await rpc.representative.factList()).toEqual([]);

    await rpc.representative.factProposalApprove({ id: proposal!.id });

    expect(await rpc.representative.factList()).toMatchObject([
      { key: lesson.key, value: lesson.value },
    ]);
    expect(await rpc.representative.factLog()).toMatchObject([
      { key: lesson.key, action: "add", proposedBy: "Customer memory pass" },
    ]);
    expect(await rpc.representative.factProposals()).toEqual([]);
    // No card in a Bot's Conversation, and nothing to wake it.
    expect(await botMessages()).toBe(before);
  });

  it("creates no fact when the owner declines", async () => {
    const { rpc, closeThread, botMessages } = await instance(replying(JSON.stringify(lesson)));
    const before = await botMessages();
    await closeThread();
    const [proposal] = await rpc.representative.factProposals();

    await rpc.representative.factProposalDecline({ id: proposal!.id });

    expect(await rpc.representative.factProposals()).toEqual([]);
    expect(await rpc.representative.factList()).toEqual([]);
    expect(await botMessages()).toBe(before);
  });

  // One runner per test: a second instance's runner would share the job table with the first's.
  it.each([
    ["a null lesson", "null"],
    ["a reply that isn't JSON", "not json"],
    ["an invalid key", JSON.stringify({ ...lesson, key: "Bad Key!" })],
  ])("proposes nothing for %s, and the summary still lands", async (_name, tail) => {
    const { rpc, closeThread, customerOf } = await instance(replying(tail));
    await closeThread();
    expect(await rpc.representative.factProposals()).toEqual([]);
    expect(
      await rpc.representative.customerSummaryList({ id: (await customerOf()).id }),
    ).toHaveLength(1);
  });

  it("proposes nothing when the reply has no lesson section", async () => {
    const { rpc, closeThread } = await instance(() => round(text("Only a summary.")));
    await closeThread();
    expect(await rpc.representative.factProposals()).toEqual([]);
  });

  it.each([
    "Ring Ada on +44 20 7946 0958 to book.",
    "Ring Ada on (415) 555-0100 to book.",
    "Write to ada@example.com for a quote.",
  ])("is refused by code when it holds a phone number or an email: %s", async (value) => {
    const { rpc, closeThread, customerOf } = await instance(
      replying(JSON.stringify({ ...lesson, value })),
    );
    await closeThread();
    expect(await rpc.representative.factProposals()).toEqual([]);
    expect(
      await rpc.representative.customerSummaryList({ id: (await customerOf()).id }),
    ).toHaveLength(1);
  });

  it.each([
    ["Ada Lovelace asked for a quote", "name"],
    ["Visit 12 Grimshaw Lane for the boiler", "address"],
    ["Message adahandle again about it", "identity"],
  ] as const)("is refused when it holds the Customer's value: %s", async (value, set) => {
    const world = await instance(replying(JSON.stringify({ ...lesson, value })));
    await world.closeThread(async () => {
      const customer = await world.customerOf();
      if (set === "name") {
        await world.rpc.representative.customerRename({ id: customer.id, name: "Ada Lovelace" });
      } else if (set === "address") {
        await world.rpc.representative.customerProfileSet({
          id: customer.id,
          field: "address",
          value: "12 Grimshaw Lane",
        });
      } else {
        await world.rpc.representative.customerAddIdentity({
          id: customer.id,
          channel: "sms",
          externalId: "adahandle",
        });
      }
    });
    expect(await world.rpc.representative.factProposals()).toEqual([]);
  });

  it.each([
    ["Bob Absorbed asked for a quote", "name"],
    ["Visit 7 Absorbed Row for the boiler", "address"],
    ["Message bobhandle again about it", "identity"],
  ] as const)(
    "is refused when it holds a value of a Customer merged in: %s",
    async (value, kind) => {
      const world = await instance(replying(JSON.stringify({ ...lesson, value })));
      await world.closeThread(async () => {
        const { rpc } = world;
        const bob = await rpc.representative.customerCreate({
          channel: "sms",
          externalId: kind === "identity" ? "bobhandle" : "+15550002",
          name: "Bob Absorbed",
        });
        await rpc.representative.customerProfileSet({
          id: bob.id,
          field: "address",
          value: "7 Absorbed Row",
        });
        const ada = (await rpc.representative.customerList()).find((each) =>
          each.identities.some((identity) => identity.externalId === "+15550001"),
        )!;
        await rpc.representative.customerMerge({ id: bob.id, intoId: ada.id });
      });
      expect(await world.rpc.representative.factProposals()).toEqual([]);
    },
  );

  it.each([
    ["only part of another word", "Customers affirm they want a quote first.", 1],
    ["a whole word", "Customers want a firm quote first.", 0],
  ])("reads a Customer value that is %s", async (_name, value, proposals) => {
    const world = await instance(replying(JSON.stringify({ ...lesson, value })));
    await world.closeThread(async () => {
      const customer = await world.customerOf();
      await world.rpc.representative.customerProfileSet({
        id: customer.id,
        field: "language",
        value: "firm",
      });
    });
    expect(await world.rpc.representative.factProposals()).toHaveLength(proposals);
  });

  it("stores no Customer or thread link, and is in the owner's export and delete", async () => {
    const { deps, user, rpc, closeThread, customerOf } = await instance(
      replying(JSON.stringify(lesson)),
    );
    await closeThread();
    const customer = await customerOf();
    const [thread] = await rpc.representative.customerSummaryList({ id: customer.id });

    const [row] = await getTestDb()
      .select()
      .from(representativeFactProposal)
      .where(eq(representativeFactProposal.userId, user.id));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(customer.id);
    expect(stored).not.toContain(thread!.threadId);
    expect(Object.keys(row!).join()).not.toMatch(/customer|thread/i);

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { factProposals: unknown };
    };
    expect(exported.representative.factProposals).toMatchObject([
      { key: lesson.key, botId: null, proposed: { value: lesson.value } },
    ]);

    await deleteUserData(deps, user.id);
    expect(
      await getTestDb()
        .select({ id: representativeFactProposal.id })
        .from(representativeFactProposal)
        .where(eq(representativeFactProposal.userId, user.id)),
    ).toEqual([]);
  });

  it.each([0, 1])("leaves the profile operations working beside it, in order %i", async (which) => {
    const operations = JSON.stringify([{ field: "language", value: "fix it today", line: 1 }]);
    const sections = [
      [lessonMarker, JSON.stringify(lesson)].join(newline),
      [profileOperationsMarker, operations].join(newline),
    ];
    const order = which === 0 ? sections : sections.toReversed();
    const { rpc, closeThread, customerOf } = await instance(() =>
      round(text(["A summary.", ...order].join(newline))),
    );
    await closeThread();
    expect(await rpc.representative.factProposals()).toHaveLength(1);
    expect((await customerOf()).profile).toMatchObject([
      { field: "language", value: "fix it today" },
    ]);
  });
});
