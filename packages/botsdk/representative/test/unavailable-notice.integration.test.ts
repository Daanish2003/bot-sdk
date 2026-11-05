import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representativeCustomerIdentity,
  representativeOutboundDecision,
} from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";
import { unavailableNotice } from "../src/server/unavailable-notice";

/*
 * The fixed notice when nobody can answer (ticket #1332), through the real inbound path: a Representative
 * switched off, or with no approved Release, tells a Customer so once per thread, with no model call. What
 * a Customer got is what the Channel recorded, and why is the decision log.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550003";
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");
const script = "Call 112, or leave the building now.";

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance with an approved, enabled Representative whose Release has an emergency keyword. */
async function instance() {
  const fake = createFakeAdapter({ rounds: [round(), round(), round()] });
  const sent: string[] = [];
  const channel: CustomerChannel = {
    send: async (_to, { text }) => {
      sent.push(text);
    },
    sendProof: async () => {},
  };
  const timer = fakeJobClock(at);
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => made!.parts.jobs,
  });
  const deps = createTestSdk({
    jobs,
    features: [representativeFeature({}, channel)],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
  });
  made = deps;
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
      tools: ["reply"],
      emergencyText: script,
      emergencyKeywords: ["fire"],
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const world = Object.assign(deps, { timer });
  const decisions = async (representativeId = id) => {
    const [thread] = await rpc.representative.threadList({ id: representativeId });
    return (
      await getTestDb()
        .select()
        .from(representativeOutboundDecision)
        .where(eq(representativeOutboundDecision.threadId, thread!.id))
        .orderBy(asc(representativeOutboundDecision.id))
    ).map(({ kind, outcome, rule }) => [kind, outcome, rule]);
  };
  return {
    fake,
    sent,
    rpc,
    id,
    user,
    decisions,
    /** A Representative with no approved Release. */
    unreleased: async () => (await rpc.representative.create({ name: "Unreleased" })).id,
    hears: (message: string, representativeId = id, externalId = number) =>
      testCustomerTurn(world, { representativeId, externalId, message }),
    thread: async (representativeId = id) =>
      rpc.representative.threadGet({
        id: (await rpc.representative.threadList({ id: representativeId }))[0]!.id,
      }),
  };
}

const sentNotice = ["unavailable_notice", "send", "passed"];

describe("a switched-off Representative", () => {
  it("tells a Customer who writes so, with no model call, and logs it", async () => {
    const world = await instance();
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });

    await world.hears("Hello?");

    await expect.poll(() => world.sent, poll).toEqual([unavailableNotice]);
    expect(world.fake.calls).toEqual([]);
    expect(await world.decisions()).toEqual([sentNotice]);
    expect((await world.thread()).messages.map(({ author, text }) => [author, text])).toEqual([
      ["customer", "Hello?"],
      ["note", unavailableNotice],
    ]);
  });

  it("tells a thread once: a second message gets no second notice", async () => {
    const world = await instance();
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });

    await world.hears("Hello?");
    await world.hears("Anyone there?");

    await expect.poll(() => world.sent, poll).toEqual([unavailableNotice]);
    expect(await world.decisions()).toEqual([sentNotice]);
    expect((await world.thread()).messages).toHaveLength(3);
  });

  it("sends a blocked Customer nothing, and logs no notice", async () => {
    const world = await instance();
    await world.hears("Hi");
    const { customer } = await world.thread();
    await world.rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    world.sent.length = 0;
    world.fake.calls.length = 0;

    await world.hears("Hello again");

    expect(await world.decisions()).not.toContainEqual(
      expect.arrayContaining(["unavailable_notice"]),
    );
    expect(world.sent).not.toContain(unavailableNotice);
    expect(world.fake.calls).toEqual([]);
  });

  it("sends an opted-out Customer nothing, and logs no notice", async () => {
    const world = await instance();
    await world.hears("STOP");
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });
    expect(
      await getTestDb()
        .select({ at: representativeCustomerIdentity.optedOutAt })
        .from(representativeCustomerIdentity),
    ).not.toEqual([]);

    await world.hears("Hello again");

    expect(world.sent).not.toContain(unavailableNotice);
    expect(await world.decisions()).not.toContainEqual(
      expect.arrayContaining(["unavailable_notice"]),
    );
  });

  it("still sends the emergency script, and not the notice, for an emergency keyword", async () => {
    const world = await instance();
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });

    await world.hears("Fire!");

    await expect.poll(() => world.sent, poll).toEqual([script]);
    expect(await world.decisions()).toEqual([["emergency_script", "send", "passed"]]);
  });
});

describe("a Representative with no approved Release", () => {
  it("tells a Customer who writes so, with no model call, and logs it", async () => {
    const world = await instance();
    const unreleased = await world.unreleased();

    await world.hears("Hello?", unreleased);

    await expect.poll(() => world.sent, poll).toEqual([unavailableNotice]);
    expect(world.fake.calls).toEqual([]);
    expect(await world.decisions(unreleased)).toEqual([sentNotice]);
  });

  it("tells a thread once", async () => {
    const world = await instance();
    const unreleased = await world.unreleased();

    await world.hears("Hello?", unreleased);
    await world.hears("Anyone there?", unreleased);

    await expect.poll(() => world.sent, poll).toEqual([unavailableNotice]);
    expect(await world.decisions(unreleased)).toEqual([sentNotice]);
  });
});

describe("a Representative that is on with a Release", () => {
  it("sends no notice", async () => {
    const world = await instance();

    await world.hears("Hello?");

    expect(await world.decisions()).not.toContainEqual(
      expect.arrayContaining(["unavailable_notice"]),
    );
    expect(world.sent).not.toContain(unavailableNotice);
  });
});
