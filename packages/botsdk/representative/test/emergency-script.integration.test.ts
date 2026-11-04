import type { AnyTextAdapter } from "@tanstack/ai";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { page } from "@botsdk/bot/storage";
import { webPushChannel } from "@botsdk/bot/channel";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { startTestCustomerTurn, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter, fakePushProvider } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import { storeReply } from "../src/server/customers";
import { representativeOutboundDecision, representativeRelease } from "../src/server/db/schema";
import { liveChecks, passGate } from "../src/server/outbound-gate";
import { representativeFeature } from "../src/server/plugin";

/*
 * The emergency script (ticket #1308), through the real inbound and reply paths: a fake Model on real
 * Postgres, a Customer channel over `fakeMessagingAdapter` and a fake push provider for the owner's
 * Page. What a Customer got is what the fake recorded, and why is the decision log.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550002";
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");
const script = "Call 112, or leave the building now.";
const defaultScript = "If this is an emergency, call your local emergency number";
const device = {
  endpoint: "https://push.example/send/phone",
  keys: { p256dh: "Bphone".padEnd(87, "A"), auth: "aphone".padEnd(22, "A") },
};

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const flags = (id = "flag") => round(toolCall({ name: "flag_emergency", input: {}, id }));

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance with an approved Release holding `keywords` and the fixed text. */
async function instance(rounds: Round[], keywords: string[] = ["gas leak", "fire"]) {
  const fake = createFakeAdapter({ rounds });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      yield* fake.adapter.chatStream(options);
    },
  };
  const messaging = fakeMessagingAdapter();
  const account = {
    id: "account",
    botId: "bot",
    platformBotId: "1",
    handle: "@bot_1",
    credentials: { token: "1:secret" },
  };
  const channel: CustomerChannel = {
    send: async (to, { text }) => {
      await messaging.adapter.send(account, { chatId: to.externalId, text }, { fetch });
    },
    sendProof: async () => {},
  };
  const timer = fakeJobClock(at);
  const push = fakePushProvider();
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
    channels: [webPushChannel({ provider: push.provider, appUrl: "https://app.example" })],
    features: [representativeFeature({}, channel)],
    adapterFor: () => adapter,
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
      emergencyKeywords: keywords,
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  const to = { channel: "fake", externalId: number };
  return {
    entered,
    push,
    rpc,
    id,
    deps: world,
    threadId,
    to,
    hears: (message: string) =>
      testCustomerTurn(world, { representativeId: id, externalId: number, message }),
    starts: (message: string) =>
      startTestCustomerTurn(world, { representativeId: id, externalId: number, message }),
    /** What reached the Customer, in the order the fake sent it. */
    got: () => messaging.delivered.map(({ part }) => part),
    thread: async () => rpc.representative.threadGet({ id: await threadId() }),
    decisions: async () =>
      (
        await getTestDb()
          .select()
          .from(representativeOutboundDecision)
          .where(eq(representativeOutboundDecision.threadId, await threadId()))
          .orderBy(asc(representativeOutboundDecision.id))
      ).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    pages: () => getTestDb().select().from(page).where(eq(page.userId, user.id)),
    /** A reply as the tool stores it, on a topic the owner promoted. */
    reply: async () => {
      const feature = world.parts.features.find(({ feature }) => feature.id === "representative")!;
      const thread = await threadId();
      return getTestDb().transaction((tx) =>
        storeReply(
          feature.context,
          tx,
          { threadId: thread, upTo: 1, heard: to, verified: false },
          { text: "Hi", sources: [], topic: "general" },
          "small_talk",
          at,
        ),
      );
    },
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** The script went out, as a decision of its own that no rule stopped, and the owner was Paged once. */
async function expectScriptSent(world: World) {
  await expect.poll(world.got, poll).toContain(script);
  expect(await world.decisions()).toContainEqual(["emergency_script", "send", "passed"]);
  expect((await world.pages()).filter(({ urgency }) => urgency === "emergency")).toMatchObject([
    { cause: "emergency_script" },
  ]);
}

describe("a keyword in the Release", () => {
  it("sends the Release's text at once, with no model call, and keeps the message for the owner", async () => {
    const world = await instance([]);

    await world.hears("There's a GAS   leak, in my kitchen!");

    expect(world.entered).toEqual([]);
    await expectScriptSent(world);
    const { messages } = await world.thread();
    expect(messages.map(({ author, text }) => [author, text])).toEqual([
      ["customer", "There's a GAS   leak, in my kitchen!"],
      ["note", script],
    ]);
  });

  it("is a whole word: a word holding it is just a word", async () => {
    const world = await instance([quiet()]);

    await world.hears("I was fired from my job");

    expect(world.entered).toHaveLength(1);
    expect(world.got()).toEqual([]);
    expect(await world.pages()).toEqual([]);
  });

  it("takes along what waited for a Turn: the Model doesn't answer it after the script", async () => {
    const world = await instance([]);
    const { jobId } = await world.starts("Hello?");

    await world.hears("Fire!");
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect
      .poll(async () => (await world.deps.runner.status(jobId))?.status, poll)
      .toBe("succeeded");

    expect(world.entered).toEqual([]);
    await expectScriptSent(world);
  });

  it("overrides a topic the owner hasn't promoted", async () => {
    const world = await instance([]);

    await world.hears("fire");

    await expectScriptSent(world);
    expect((await world.thread()).held).toEqual([]);
  });

  it("overrides a spent cap, and doesn't count against it", async () => {
    const world = await instance([quiet()]);
    await world.rpc.representative.setCaps({ id: world.id, maxPerDay: 1 });
    await world.hears("Hello");
    expect(await world.reply()).toEqual({ sent: true });
    // The cap is spent: everything but the script would be held.
    expect(await world.reply()).toHaveProperty("error");

    await world.hears("fire");

    await expectScriptSent(world);
    await expect.poll(world.got, poll).toEqual(["Hi", script]);
  });

  it("overrides quiet hours, even for what the business starts", async () => {
    const world = await instance([]);
    await world.rpc.representative.setQuietHours({
      id: world.id,
      startHour: 8,
      endHour: 12,
      timeZone: "UTC",
    });

    await world.hears("fire");

    await expectScriptSent(world);
    expect((await world.thread()).held).toEqual([]);
    // A flag on a Turn relaying a Bot's result is what the business starts.
    const threadId = await world.threadId();
    const started = await getTestDb().transaction((tx) =>
      passGate(tx, {
        kind: "emergency_script",
        threadId,
        to: world.to,
        now: at,
        businessStarted: true,
        content: { text: script, verified: false },
      }),
    );
    expect(started).toMatchObject({ outcome: "send" });
  });

  it("overrides the owner's hold on the thread, and starts no Turn", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const taken = world.entered.length;
    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });

    await world.hears("fire");

    await expectScriptSent(world);
    expect(world.entered).toHaveLength(taken);
    expect((await world.thread()).holder).toBe("owner");
  });

  it("reaches an opted-out Customer, whose opt-out stands", async () => {
    const world = await instance([]);
    await world.hears("STOP");

    await world.hears("fire");

    await expectScriptSent(world);
    expect((await world.thread()).identities[0]).toMatchObject({ optedOut: { source: "keyword" } });
  });

  it("sends a blocked Customer nothing, logs why, and doesn't Page the owner", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const { customer } = await world.thread();
    await world.rpc.representative.customerSetBlocked({ id: customer.id, blocked: true });

    await world.hears("fire");

    expect(await world.decisions()).toEqual([["emergency_script", "drop", "blocked"]]);
    expect(world.got()).toEqual([]);
    expect(await world.pages()).toEqual([]);
  });

  it("is sent by a switched-off Representative with an approved Release", async () => {
    const world = await instance([]);
    await world.rpc.representative.setEnabled({ id: world.id, enabled: false });

    await world.hears("fire");

    await expectScriptSent(world);
  });

  it("does nothing for a Representative with no approved Release", async () => {
    const world = await instance([]);
    const { id: unreleased } = await world.rpc.representative.create({ name: "Unreleased" });

    await testCustomerTurn(world.deps, {
      representativeId: unreleased,
      externalId: number,
      message: "fire",
    });

    expect(world.got()).toEqual([]);
    expect(await world.pages()).toEqual([]);
  });
});

describe("the emergency Page", () => {
  it("goes at once, inside the owner's hours, and carries none of the Customer's words", async () => {
    const world = await instance([]);
    await world.rpc.notifications.push.subscribe(device);
    await world.rpc.notifications.update({
      quietHours: { start: "08:00", end: "12:00" },
      urgent: null,
      other: null,
    });

    await world.hears("fire, please help");

    await expect.poll(() => world.push.sent.length, poll).toBe(1);
    expect(JSON.stringify(world.push.sent[0])).not.toContain("please help");
  });
});

describe("a Representative's flag", () => {
  it("is offered on a Release that lists only reply, and sends the same text, once in a Turn", async () => {
    const world = await instance([flags("first"), flags("second"), quiet()], []);

    await world.hears("There's smoke coming from the stairs");

    const offered = (world.entered[0] as { tools?: { name: string }[] }).tools?.map((t) => t.name);
    expect(offered).toContain("flag_emergency");
    await expectScriptSent(world);
    expect(world.got()).toEqual([script]);
  });
});

describe("the gate", () => {
  it("passes the script through every rule that can fail, except a block", async () => {
    const world = await instance([quiet()]);
    await world.hears("Hello");
    const threadId = await world.threadId();
    const failing = Object.fromEntries(
      Object.keys(liveChecks).map((rule) => [rule, () => "hold" as const]),
    );
    const gate = (checks: typeof failing) =>
      getTestDb().transaction((tx) =>
        passGate(
          tx,
          {
            kind: "emergency_script",
            threadId,
            to: world.to,
            now: at,
            businessStarted: true,
            content: { text: script, verified: false },
          },
          checks,
        ),
      );

    const { blocked, ...others } = failing;
    expect(await gate(others)).toMatchObject({ outcome: "send", rule: "passed" });
    expect(await gate({ blocked: blocked! })).toMatchObject({ outcome: "hold", rule: "blocked" });
  });
});

describe("what the Release holds", () => {
  it("reads the default text and no keywords on an older Release, which triggers only on a flag", async () => {
    const world = await instance([quiet(), flags(), quiet()]);
    await getTestDb().execute(
      sql`update botsdk.representative_release set content = content - 'emergencyText' - 'emergencyKeywords' where representative_id = ${world.id}`,
    );
    await getTestDb().execute(
      sql`update botsdk.representative set draft = draft - 'emergencyText' - 'emergencyKeywords' where id = ${world.id}`,
    );

    const view = await world.rpc.representative.get({ id: world.id });
    expect(view.liveRelease?.content).toMatchObject({
      emergencyText: defaultScript,
      emergencyKeywords: [],
    });
    expect(view.draft).toMatchObject({ emergencyText: defaultScript, emergencyKeywords: [] });
    expect((await world.rpc.representative.diff({ id: world.id })).changes).toEqual([]);

    await world.hears("fire");
    expect(world.got()).toEqual([]);
    expect(world.entered).toHaveLength(1);

    await world.hears("There's smoke");
    await expect.poll(world.got, poll).toEqual([defaultScript]);
  });

  it("starts a new draft on the default text with no keywords", async () => {
    const world = await instance([]);

    const { id } = await world.rpc.representative.create({ name: "New" });

    expect((await world.rpc.representative.get({ id })).draft).toMatchObject({
      emergencyText: defaultScript,
      emergencyKeywords: [],
    });
  });

  it("lets the owner edit both on the draft, and a Release freezes them until the next", async () => {
    const world = await instance([quiet()]);
    const edited = "Dial 999.";

    const saved = await world.rpc.representative.updateDraft({
      id: world.id,
      draft: { emergencyText: edited, emergencyKeywords: ["flood"] },
    });
    expect(saved.draft).toMatchObject({ emergencyText: edited, emergencyKeywords: ["flood"] });
    expect(saved.liveRelease?.content).toMatchObject({
      emergencyText: script,
      emergencyKeywords: ["gas leak", "fire"],
    });
    expect(
      (await world.rpc.representative.diff({ id: world.id })).changes.map(({ field }) => field),
    ).toEqual(["emergencyText", "emergencyKeywords"]);

    // The live Release still decides.
    await world.hears("flood");
    expect(world.got()).toEqual([]);
    await world.hears("fire");
    await expect.poll(world.got, poll).toEqual([script]);

    await world.rpc.representative.approve({ id: world.id });
    await world.hears("flood");
    await expect.poll(world.got, poll).toEqual([script, edited]);
  });

  it("refuses an empty text, and a keyword that's only spaces", async () => {
    const world = await instance([]);

    await expect(
      world.rpc.representative.updateDraft({ id: world.id, draft: { emergencyText: "   " } }),
    ).rejects.toThrow();
    await expect(
      world.rpc.representative.updateDraft({ id: world.id, draft: { emergencyKeywords: [" "] } }),
    ).rejects.toThrow();
  });

  it("goes back with the Release that is rolled back to", async () => {
    const world = await instance([]);
    const [first] = await getTestDb()
      .select({ id: representativeRelease.id })
      .from(representativeRelease)
      .where(eq(representativeRelease.representativeId, world.id));
    await world.rpc.representative.updateDraft({
      id: world.id,
      draft: { emergencyText: "Dial 999.", emergencyKeywords: ["flood"] },
    });
    await world.rpc.representative.approve({ id: world.id });

    await world.rpc.representative.rollback({ id: world.id, releaseId: first!.id });
    await world.hears("fire");

    await expect.poll(world.got, poll).toEqual([script]);
  });
});
