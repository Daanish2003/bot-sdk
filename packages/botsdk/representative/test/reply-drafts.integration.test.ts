import type { AnyTextAdapter } from "@tanstack/ai";
import { noCustomerChannel } from "../src/server/customer-proof";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { page } from "@botsdk/bot/storage";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { startTestCustomerTurn, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThreadMessage,
  representativeTopic,
} from "../src/server/db/schema";
import { threadIdleMs } from "../src/server/idle";
import { type GateRefusal, logRefusals, passGate } from "../src/server/outbound-gate";
import { representativeFeature } from "../src/server/plugin";
import { draftDueMs } from "../src/server/draft-due";
import { holdingNote } from "../src/server/reply-drafts";

/*
 * Reply drafts (ticket #1306), through the Representative's real reply path: a fake Model on real
 * Postgres, and a Customer channel over `fakeMessagingAdapter`. What a Customer got is what the fake
 * recorded, and why is the decision log. The test Customer's owner has `general` promoted, so a reply
 * labelled anything else here is a draft.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const number = "+15550001";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const replies = (text: string, topic?: string, sources?: object[]) =>
  round(toolCall({ name: "reply", input: { text, kind: "small_talk", topic, sources } }));

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A promise a test resolves, which resolves by itself when the test ends. */
function opening() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  onTestFinished(() => open());
  return { opened, open };
}

async function instance(rounds: Round[], held?: Promise<void> | (() => Promise<void>)) {
  const fake = createFakeAdapter({ rounds });
  const entered: { messages: unknown }[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options as never);
      await (typeof held === "function" ? held() : held);
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
  const timer = fakeJobClock(new Date());
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
    draft: { jobText: "Answer questions.", model, tools: ["reply"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await rpc.representative.factAdd(generalFact);
  const world = Object.assign(deps, { timer });
  const threadId = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  return {
    messaging,
    entered,
    timer,
    rpc,
    id,
    user,
    deps: world,
    threadId,
    hears: (message: string, proof?: { rule: "sameIdentity" }, externalId = number) =>
      testCustomerTurn(world, { representativeId: id, externalId, message, proof }),
    got: () => messaging.delivered.map(({ part }) => part),
    transcript: async () =>
      (await rpc.representative.threadGet({ id: await threadId() })).messages.map(
        ({ author, text }) => [author, text],
      ),
    decisions: async () =>
      (
        await getTestDb()
          .select()
          .from(representativeOutboundDecision)
          .where(eq(representativeOutboundDecision.threadId, await threadId()))
          .orderBy(asc(representativeOutboundDecision.id))
      ).map(({ kind, outcome, rule }) => [kind, outcome, rule]),
    /** The owner's waiting drafts, the only way the owner reaches one. */
    drafts: () => rpc.representative.replyDraftList(),
    /** What became of each message the gate held on the thread, oldest first. */
    outcomes: async () =>
      (
        await getTestDb()
          .select()
          .from(representativeHeldMessage)
          .where(eq(representativeHeldMessage.threadId, await threadId()))
          .orderBy(asc(representativeHeldMessage.id))
      ).map(({ text, resolution }) => [text, resolution]),
  };
}

type World = Awaited<ReturnType<typeof instance>>;

/** The one draft waiting: a reply labelled `billing`, which nothing promotes. */
async function oneDraft(rounds: Round[] = []) {
  const world = await instance([replies("You owe nothing.", "billing"), quiet(), ...rounds]);
  await world.hears("What do I owe?");
  const [draft] = await world.drafts();
  expect(draft).toMatchObject({ text: "You owe nothing.", topic: "billing" });
  await expect.poll(world.got, poll).toEqual([holdingNote]);
  return { world, draftId: draft!.id };
}

/** A Published fact on the topic the test Customer's owner has promoted, which a reply there cites. */
const generalFact = { key: "greeting", type: "text", topic: "General", value: "Hello" } as const;
const generalSource = { type: "fact", key: generalFact.key };

const refusalCode = (error: unknown) => (error as { data?: { code?: string } }).data?.code;

describe("a reply on a draft topic", () => {
  it("isn't sent, and one holding note goes with no model call", async () => {
    const world = await instance([replies("You owe nothing.", "billing"), quiet()]);
    await world.rpc.representative.topicAdd({ name: "billing" });

    await world.hears("What do I owe?");

    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect(await world.transcript()).toEqual([
      ["customer", "What do I owe?"],
      ["note", holdingNote],
    ]);
    expect(await world.decisions()).toEqual([
      ["reply", "hold", "topic"],
      ["holding_note", "send", "passed"],
    ]);
    // The reply's round and the one that ended the Turn: the note cost none.
    expect(world.entered).toHaveLength(2);
    expect(await world.drafts()).toMatchObject([
      {
        text: "You owe nothing.",
        topic: "billing",
        representativeId: world.id,
        threadId: await world.threadId(),
        to: { channel: "fake", externalId: number },
      },
    ]);
  });

  it("says the thread waits on the owner, and it doesn't close as idle", async () => {
    const { world } = await oneDraft();
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    expect(line!.waitingOn).toBe("owner");

    world.timer.advance(threadIdleMs * 2);
    world.timer.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const [after] = await world.rpc.representative.threadList({ id: world.id });
    expect(after!.holder).toBe("representative");
    expect(await world.drafts()).toHaveLength(1);
  });

  it("tells the Model it waits, which isn't a refusal, and code doesn't hand off", async () => {
    const world = await instance([
      replies("You owe nothing.", "billing"),
      round(toolCall({ name: "reply", input: { text: "It is 10 USD.", kind: "answer" } })),
      replies("Nothing is due.", "billing"),
      quiet(),
    ]);

    await world.hears("What do I owe?");

    // A refusal made good by a draft: nothing more for the Customer than the holding note.
    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect((await world.drafts()).map(({ text }) => text)).toEqual([
      "You owe nothing.",
      "Nothing is due.",
    ]);
    expect(JSON.stringify(world.entered[1]!.messages)).toContain("waiting for the owner");
  });

  it("is a draft when its topic is unknown, or it has none", async () => {
    for (const label of ["never-heard-of", undefined]) {
      const world = await instance([replies("Sure.", label), quiet()]);

      await world.hears("Hello");

      await expect.poll(world.got, poll).toEqual([holdingNote]);
      expect(await world.decisions()).toEqual([
        ["reply", "hold", "topic"],
        ["holding_note", "send", "passed"],
      ]);
      expect((await world.drafts())[0]!.topic).toBe(label ?? null);
    }
  });

  it("is sent when the owner has promoted its topic, whatever the case of the label", async () => {
    const world = await instance([replies("Hi.", "GENERAL", [generalSource]), quiet()]);

    await world.hears("Hello");

    await expect.poll(world.got, poll).toEqual(["Hi."]);
    expect(await world.decisions()).toEqual([["reply", "send", "passed"]]);
    expect(await world.drafts()).toEqual([]);
  });
});

describe("the owner's topics", () => {
  it("all start at draft, and a Turn is told their names but not which go out alone", async () => {
    const world = await instance([replies("You owe nothing.", "Billing"), quiet()]);

    expect(await world.rpc.representative.topicAdd({ name: "Billing" })).toMatchObject({
      name: "Billing",
      mode: "draft",
    });
    await world.hears("What do I owe?");

    await expect.poll(world.got, poll).toEqual([holdingNote]);
    const prompt = JSON.stringify(world.entered[0]!.messages);
    expect(prompt).toContain("Billing");
    expect(prompt).not.toContain("auto");
  });

  it("refuses the same name twice, ignoring case, and can remove one", async () => {
    const { rpc } = await instance([]);
    const { id } = await rpc.representative.topicAdd({ name: "Billing" });

    await expect(rpc.representative.topicAdd({ name: " billing " })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.topicExists",
    );
    await rpc.representative.topicRemove({ id });
    expect(await rpc.representative.topicList()).toEqual([]);
  });

  it("are the owner's: another can't read or remove them, and another's promotion lets nothing out", async () => {
    const world = await instance([replies("You owe nothing.", "billing"), quiet()]);
    const other = await insertUser();
    const otherRpc = chatRpc({ user: other, deps: world.deps });
    const { id } = await world.rpc.representative.topicAdd({ name: "billing" });

    expect(await otherRpc.representative.topicList()).toEqual([]);
    await expect(otherRpc.representative.topicRemove({ id })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.topicNotFound",
    );
    await getTestDb()
      .insert(representativeTopic)
      .values({ id: crypto.randomUUID(), userId: other.id, name: "billing", mode: "auto" });

    await world.hears("What do I owe?");
    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect((await world.rpc.representative.topicList()).map(({ mode }) => mode)).toContain("draft");
  });

  it("are in the owner's export", async () => {
    const world = await instance([]);
    await world.rpc.representative.topicAdd({ name: "billing" });

    const exported = (await exportUserData(world.deps, world.user.id)) as unknown as {
      representative: { topics: unknown[] };
    };

    expect(exported.representative.topics).toMatchObject([{ name: "billing", mode: "draft" }]);
  });
});

describe("approving a draft", () => {
  it("sends it through the gate, and it goes once", async () => {
    const { world, draftId } = await oneDraft();

    await world.rpc.representative.replyDraftApprove({ id: draftId });

    await expect.poll(world.got, poll).toEqual([holdingNote, "You owe nothing."]);
    expect(await world.decisions()).toEqual([
      ["reply", "hold", "topic"],
      ["holding_note", "send", "passed"],
      ["reply_draft", "send", "passed"],
    ]);
    expect(await world.transcript()).toEqual([
      ["customer", "What do I owe?"],
      ["note", holdingNote],
      ["representative", "You owe nothing."],
    ]);
    expect(await world.drafts()).toEqual([]);
    expect(await world.outcomes()).toEqual([["You owe nothing.", "approved"]]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftGone",
    );
  });

  it("sends nothing to a Customer blocked since, and the draft still waits", async () => {
    const { world, draftId } = await oneDraft();
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftNotSent",
    );

    expect((await world.decisions()).at(-1)).toEqual(["reply_draft", "drop", "blocked"]);
    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
    expect(world.got()).toEqual([holdingNote]);
  });

  it("can't be done by another owner, who can't see it either", async () => {
    const { world, draftId } = await oneDraft();
    const other = await insertUser();
    const otherRpc = chatRpc({ user: other, deps: world.deps });

    expect(await otherRpc.representative.replyDraftList()).toEqual([]);
    for (const act of [
      () => otherRpc.representative.replyDraftApprove({ id: draftId }),
      () => otherRpc.representative.replyDraftEdit({ id: draftId, text: "Pay me." }),
      () => otherRpc.representative.replyDraftReject({ id: draftId }),
    ]) {
      await expect(act()).rejects.toSatisfy(
        (error) => refusalCode(error) === "error.replyDraftNotFound",
      );
    }
    expect(world.got()).toEqual([holdingNote]);
    expect(await world.drafts()).toHaveLength(1);
  });
});

describe("editing a draft", () => {
  it("sends the edited text and records that it was edited", async () => {
    const { world, draftId } = await oneDraft();

    await world.rpc.representative.replyDraftEdit({ id: draftId, text: "You owe 5 USD." });

    await expect.poll(world.got, poll).toEqual([holdingNote, "You owe 5 USD."]);
    expect((await world.transcript()).at(-1)).toEqual(["owner", "You owe 5 USD."]);
    // The original stays with the record of what became of it.
    expect(await world.outcomes()).toEqual([["You owe nothing.", "edited"]]);
    const [message] = await getTestDb()
      .select({ id: representativeThreadMessage.id })
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.text, "You owe 5 USD."));
    const [held] = await getTestDb()
      .select({ messageId: representativeHeldMessage.messageId })
      .from(representativeHeldMessage)
      .where(eq(representativeHeldMessage.id, draftId));
    expect(held!.messageId).toBe(message!.id);
  });
});

describe("rejecting a draft", () => {
  it("sends nothing, and it can't be approved after", async () => {
    const { world, draftId } = await oneDraft();

    await world.rpc.representative.replyDraftReject({ id: draftId });

    expect(await world.drafts()).toEqual([]);
    expect(await world.outcomes()).toEqual([["You owe nothing.", "rejected"]]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftGone",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.got()).toEqual([holdingNote]);
  });
});

describe("a new Customer message", () => {
  it("replaces the draft, which can't be approved, and the next draft gets its own note", async () => {
    const { world, draftId } = await oneDraft([replies("Still nothing.", "billing"), quiet()]);

    await world.hears("Are you sure?");

    expect(await world.outcomes()).toEqual([
      ["You owe nothing.", "replaced"],
      ["Still nothing.", null],
    ]);
    expect((await world.drafts()).map(({ text }) => text)).toEqual(["Still nothing."]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftGone",
    );
    await expect.poll(world.got, poll).toEqual([holdingNote, holdingNote]);
  });

  it("from another address, unverified, leaves a verified sender's draft alone", async () => {
    const world = await instance([replies("You owe nothing.", "billing"), quiet(), quiet()]);
    await world.hears("What do I owe?", { rule: "sameIdentity" });
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerAddIdentity({
      id: line!.customer.id,
      channel: "fake",
      externalId: "+15550002",
    });

    await world.hears("I'm them too, what's in that draft?", undefined, "+15550002");

    expect((await world.drafts()).map(({ text }) => text)).toEqual(["You owe nothing."]);
  });

  it("that came during the Turn makes that Turn's draft out of date at once, with no note for it", async () => {
    const held = opening();
    const world = await instance(
      [
        replies("You owe nothing.", "billing"),
        quiet(),
        replies("Still nothing.", "billing"),
        quiet(),
      ],
      held.opened,
    );
    const first = await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "What do I owe?",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => world.entered.length, poll).toBe(1);
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "Are you sure?",
    });
    held.open();
    await expect
      .poll(async () => (await world.deps.runner.status(first.jobId))?.status, poll)
      .toBe("succeeded");
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();

    await expect.poll(world.outcomes, poll).toEqual([
      ["You owe nothing.", "replaced"],
      ["Still nothing.", null],
    ]);
    await expect.poll(world.got, poll).toEqual([holdingNote]);
  });
});

describe("a second draft in a row", () => {
  it("sends no second holding note before the Customer writes again", async () => {
    const world = await instance([
      replies("First part.", "billing"),
      replies("Second part.", "billing"),
      quiet(),
    ]);

    await world.hears("What do I owe?");

    expect((await world.drafts()).map(({ text }) => text)).toEqual(["First part.", "Second part."]);
    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect((await world.decisions()).filter(([kind]) => kind === "holding_note")).toHaveLength(1);
  });
});

describe("the owner stepping in", () => {
  it("leaves a draft out of the list while they hold the thread, and back after Hand back", async () => {
    const { world, draftId } = await oneDraft();
    const id = await world.threadId();

    await world.rpc.representative.threadTakeOver({ id });

    expect(await world.drafts()).toEqual([]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftNotSent",
    );

    await world.rpc.representative.threadHandBack({ id });
    expect((await world.drafts()).map((draft) => draft.id)).toEqual([draftId]);
  });

  it("replaces the draft when they write to the Customer themselves", async () => {
    const { world } = await oneDraft();
    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });

    await world.rpc.representative.threadSend({ id, text: "I'll sort this out." });
    await world.rpc.representative.threadHandBack({ id });

    expect(await world.outcomes()).toEqual([["You owe nothing.", "replaced"]]);
    expect(await world.drafts()).toEqual([]);
  });

  it("replaces the draft of a Turn the takeover aborts, as that Turn's batch waits again", async () => {
    // Stands the Turn's second Model call, so the Turn is still running when the owner takes over.
    const second = opening();
    const calls = { made: 0 };
    const world = await instance([replies("You owe nothing.", "billing"), quiet()], async () => {
      calls.made += 1;
      if (calls.made === 2) await second.opened;
    });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "What do I owe?",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(2);
    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });
    second.open();

    expect(await world.outcomes()).toEqual([["You owe nothing.", "replaced"]]);
  });
});

describe("a draft whose Turn's fence rolled it back", () => {
  it("is logged, and never waits for the owner", async () => {
    const world: World = await instance([quiet()]);
    await world.hears("Hello");
    const threadId = await world.threadId();
    const refusals: GateRefusal[] = [];

    await getTestDb()
      .transaction(async (tx) => {
        await passGate(tx, {
          kind: "reply",
          channel: noCustomerChannel,
          threadId,
          to: { channel: "fake", externalId: number },
          now: world.timer.clock.now(),
          refusals,
          content: { text: "Too late.", verified: false, replyKind: "small_talk", sources: [] },
        });
        throw new Error("fenced");
      })
      .catch(() => {});
    const feature = world.deps.parts.features.find(
      ({ feature }) => feature.id === "representative",
    )!;
    await logRefusals(feature.context, refusals);

    expect((await world.decisions()).at(-1)).toEqual(["reply", "hold", "topic"]);
    expect(await world.outcomes()).toEqual([["Too late.", "cancelled"]]);
    expect(await world.drafts()).toEqual([]);
  });
});

describe("what another address was going to be told", () => {
  const second = "+15550002";

  /** A draft for the Customer's first address, unverified, on a thread with a second address too. */
  async function draftForTheFirst(rounds: Round[], held?: () => Promise<void>) {
    const world = await instance(
      [replies("You owe nothing.", "billing"), quiet(), ...rounds],
      held,
    );
    await world.hears("What do I owe?");
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerAddIdentity({
      id: line!.customer.id,
      channel: "fake",
      externalId: second,
    });
    return world;
  }

  it("still waits after a verified message from the second", async () => {
    const world = await draftForTheFirst([quiet()]);

    await world.hears("Me too", { rule: "sameIdentity" }, second);

    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
  });

  it("still waits after the owner writes to the second", async () => {
    const world = await draftForTheFirst([quiet()]);
    await world.hears("Me too", { rule: "sameIdentity" }, second);
    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });

    await world.rpc.representative.threadSend({ id, text: "Hello there." });

    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
  });

  it("still waits when the owner takes over the second's Turn", async () => {
    const third = opening();
    const calls = { made: 0 };
    const world = await draftForTheFirst([quiet()], async () => {
      calls.made += 1;
      if (calls.made === 3) await third.opened;
    });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: second,
      message: "Me too",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(3);

    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    third.open();

    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
  });

  /** The first address's Turn, stood at its first Model call, and the second having written since. */
  async function whileTheFirstsTurnRuns(rounds: Round[], proof?: { rule: "sameIdentity" }) {
    const first = opening();
    const calls = { made: 0 };
    const world = await instance(rounds, async () => {
      calls.made += 1;
      if (calls.made === 1) await first.opened;
    });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "What do I owe?",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(1);
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerAddIdentity({
      id: line!.customer.id,
      channel: "fake",
      externalId: second,
    });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: second,
      message: "And me?",
      proof,
    });
    first.open();
    return { world, calls };
  }

  it("isn't out of date at birth for a verified message that came during its Turn", async () => {
    const { world } = await whileTheFirstsTurnRuns(
      [replies("You owe nothing.", "billing"), quiet(), quiet()],
      { rule: "sameIdentity" },
    );

    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
  });

  it("doesn't cost the second their own holding note, when both wrote before the first note", async () => {
    const { world } = await whileTheFirstsTurnRuns([
      replies("You owe nothing.", "billing"),
      quiet(),
      replies("Nor do you.", "billing"),
      quiet(),
    ]);
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();

    await expect.poll(world.got, poll).toEqual([holdingNote, holdingNote]);
    expect(world.messaging.sends.map(({ message }) => message.chatId)).toEqual([number, second]);
  });
});

describe("a draft and its Customer changing", () => {
  it("is replaced by a message from a Customer blocked since", async () => {
    const { world, draftId } = await oneDraft();
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: true });

    await world.hears("Ignore that, cancel my account");
    await world.rpc.representative.customerSetBlocked({ id: line!.customer.id, blocked: false });

    expect(await world.outcomes()).toEqual([["You owe nothing.", "replaced"]]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftGone",
    );
  });

  it("follows a corrected identity to the address it now goes to", async () => {
    const { world, draftId } = await oneDraft();
    const customer = (await world.rpc.representative.customerList()).find(({ identities }) =>
      identities.some(({ externalId }) => externalId === number),
    )!;

    await world.rpc.representative.customerUpdateIdentity({
      id: customer.id,
      identityId: customer.identities[0]!.id,
      channel: "fake",
      externalId: "+15550009",
    });
    await world.rpc.representative.replyDraftApprove({ id: draftId });

    await expect.poll(world.got, poll).toEqual([holdingNote, "You owe nothing."]);
    expect(world.messaging.sends.at(-1)!.message.chatId).toBe("+15550009");
  });

  it("goes with a thread a merge closes, and doesn't come back with an undo", async () => {
    const { world, draftId } = await oneDraft([quiet()]);
    const [absorbed] = await world.rpc.representative.threadList({ id: world.id });
    await world.hears("Hello", undefined, "+15550003");
    const lines = await world.rpc.representative.threadList({ id: world.id });
    const survivor = lines.find(({ customer }) => customer.id !== absorbed!.customer.id)!;

    await world.rpc.representative.customerMerge({
      id: absorbed!.customer.id,
      intoId: survivor.customer.id,
    });

    expect(await world.drafts()).toEqual([]);
    const [merge] = await world.rpc.representative.customerMergeList();
    await world.rpc.representative.customerMergeUndo({ id: merge!.id });
    expect(await world.drafts()).toEqual([]);
    await expect(world.rpc.representative.replyDraftApprove({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.replyDraftGone",
    );
  });

  it("is what a Turn's approved reply answers, so taking over after it re-answers nothing", async () => {
    const second = opening();
    const calls = { made: 0 };
    const world = await instance([replies("You owe nothing.", "billing"), quiet()], async () => {
      calls.made += 1;
      if (calls.made === 2) await second.opened;
    });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "What do I owe?",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(2);
    const [draft] = await world.drafts();
    await world.rpc.representative.replyDraftApprove({ id: draft!.id });

    const id = await world.threadId();
    await world.rpc.representative.threadTakeOver({ id });
    second.open();

    expect((await world.rpc.representative.threadGet({ id })).waitingOn).toBe("customer");
  });
});

describe("an edit", () => {
  it("is the owner's words on the thread, resting on none of the draft's sources", async () => {
    const { world, draftId } = await oneDraft();

    await world.rpc.representative.replyDraftEdit({ id: draftId, text: "You owe 5 USD." });

    const { messages } = await world.rpc.representative.threadGet({ id: await world.threadId() });
    expect(messages.at(-1)).toMatchObject({ author: "owner", text: "You owe 5 USD." });
  });

  it("that changes nothing is an approval", async () => {
    const { world, draftId } = await oneDraft();

    await world.rpc.representative.replyDraftEdit({ id: draftId, text: "You owe nothing." });

    expect((await world.transcript()).at(-1)).toEqual(["representative", "You owe nothing."]);
    expect(await world.outcomes()).toEqual([["You owe nothing.", "approved"]]);
  });
});

describe("a label the tool couldn't store", () => {
  it("is an unknown topic, so the reply is a draft", async () => {
    const world = await instance([replies("You owe nothing.", "x".repeat(200)), quiet()]);

    await world.hears("What do I owe?");

    expect(await world.drafts()).toMatchObject([{ text: "You owe nothing.", topic: null }]);
    await expect.poll(world.got, poll).toEqual([holdingNote]);
  });
});

describe("a draft beside what the caps hold", () => {
  const pagesOf = (world: World) =>
    getTestDb().select().from(page).where(eq(page.userId, world.user.id));

  it("Pages nobody, and can't be sent or dropped as a held message", async () => {
    const { world, draftId } = await oneDraft();

    expect(await pagesOf(world)).toEqual([]);
    const thread = await world.rpc.representative.threadGet({ id: await world.threadId() });
    expect(thread.held).toEqual([]);
    for (const answer of [
      world.rpc.representative.threadHeldSend({ id: draftId }),
      world.rpc.representative.threadHeldDrop({ id: draftId }),
    ]) {
      await expect(answer).rejects.toSatisfy(
        (error) => refusalCode(error) === "error.heldMessageNotFound",
      );
    }
    expect(await world.outcomes()).toEqual([["You owe nothing.", null]]);
  });

  it("once answered, can't go out as a held message", async () => {
    const { world, draftId } = await oneDraft();
    await world.rpc.representative.replyDraftReject({ id: draftId });

    await expect(world.rpc.representative.threadHeldSend({ id: draftId })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.heldMessageNotFound",
    );

    expect(world.got()).toEqual([holdingNote]);
  });

  it("once answered, doesn't stop the Page for what a cap holds", async () => {
    const { world, draftId } = await oneDraft([
      replies("First.", "general", [generalSource]),
      replies("Second.", "general", [generalSource]),
      quiet(),
    ]);
    await world.rpc.representative.replyDraftReject({ id: draftId });
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });

    await world.hears("Anything else?");

    expect((await world.outcomes()).at(-1)).toEqual(["Second.", null]);
    expect(await pagesOf(world)).toHaveLength(1);
  });

  it("goes when the owner approves it at a cap, and counts against the day", async () => {
    const world = await instance([
      replies("First.", "general", [generalSource]),
      replies("You owe nothing.", "billing"),
      quiet(),
      replies("Third.", "general", [generalSource]),
      quiet(),
    ]);
    await world.hears("What do I owe?");
    const [draft] = await world.drafts();
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });

    await world.rpc.representative.replyDraftApprove({ id: draft!.id });

    expect((await world.decisions()).at(-1)).toEqual(["reply_draft", "send", "passed"]);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 100, maxPerDay: 2 });
    await world.hears("Thanks");
    expect((await world.outcomes()).at(-1)).toEqual(["Third.", null]);
    expect((await world.decisions()).at(-1)).toEqual(["reply", "hold", "caps"]);
  });
});

describe("what a cap holds", () => {
  const second = "+15550002";

  const heldTexts = async (world: World) =>
    (await world.rpc.representative.threadGet({ id: await world.threadId() })).held.map(
      ({ text }) => text,
    );

  /** A Turn with its second reply held by a cap, stood at its next Model call. */
  async function heldDuringATurn() {
    const next = opening();
    const calls = { made: 0 };
    const world = await instance(
      [
        replies("First.", "general", [generalSource]),
        replies("Second.", "general", [generalSource]),
        quiet(),
      ],
      async () => {
        calls.made += 1;
        if (calls.made === 3) await next.opened;
      },
    );
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "Hello",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(3);
    return { world, next };
  }

  it("doesn't come back when its Turn ends, once the owner has dropped it", async () => {
    const { world, next } = await heldDuringATurn();
    const [message] = (await world.rpc.representative.threadGet({ id: await world.threadId() }))
      .held;

    await world.rpc.representative.threadHeldDrop({ id: message!.id });
    next.open();

    await expect
      .poll(async () => {
        const [line] = await world.rpc.representative.threadList({ id: world.id });
        return line!.waitingOn;
      }, poll)
      .toBe("customer");
    expect(await heldTexts(world)).toEqual([]);
  });

  it("goes with the Turn a takeover aborts, as that Turn's batch waits again", async () => {
    // At the day's cap, so the Turn's only reply is held and its batch is still unanswered.
    const next = opening();
    const calls = { made: 0 };
    const world = await instance(
      [
        replies("First.", "general", [generalSource]),
        quiet(),
        replies("Second.", "general", [generalSource]),
        quiet(),
      ],
      async () => {
        calls.made += 1;
        if (calls.made === 4) await next.opened;
      },
    );
    await world.hears("Hello");
    await world.rpc.representative.setCaps({ id: world.id, maxPerDay: 1 });
    await startTestCustomerTurn(world.deps, {
      representativeId: world.id,
      externalId: number,
      message: "Anything else?",
    });
    world.deps.timer.advance(60_000);
    world.deps.timer.tick();
    await expect.poll(() => calls.made, poll).toBe(4);
    expect(await heldTexts(world)).toEqual(["Second."]);

    await world.rpc.representative.threadTakeOver({ id: await world.threadId() });
    next.open();

    expect(await heldTexts(world)).toEqual([]);
  });

  it("never waits, nor Pages, when its Turn's fence rolled it back", async () => {
    const world = await instance([replies("First.", "general", [generalSource]), quiet()]);
    await world.hears("Hello");
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    const threadId = await world.threadId();
    const refusals: GateRefusal[] = [];
    const feature = world.deps.parts.features.find(
      ({ feature }) => feature.id === "representative",
    )!;

    await getTestDb()
      .transaction(async (tx) => {
        await passGate(tx, {
          kind: "reply",
          channel: noCustomerChannel,
          threadId,
          to: { channel: "fake", externalId: number },
          now: world.timer.clock.now(),
          refusals,
          pages: feature.context.pages,
          content: { text: "Too late.", verified: false, replyKind: "small_talk", sources: [] },
        });
        throw new Error("fenced");
      })
      .catch(() => {});
    await logRefusals(feature.context, refusals);

    expect((await world.decisions()).at(-1)).toEqual(["reply", "hold", "caps"]);
    expect(await heldTexts(world)).toEqual([]);
    expect(await getTestDb().select().from(page).where(eq(page.userId, world.user.id))).toEqual([]);
  });

  it("still waits after an unverified message from another address", async () => {
    const world = await instance([
      replies("First.", "general", [generalSource]),
      replies("Second.", "general", [generalSource]),
      quiet(),
      quiet(),
    ]);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await world.hears("Hello");
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    await world.rpc.representative.customerAddIdentity({
      id: line!.customer.id,
      channel: "fake",
      externalId: second,
    });

    await world.hears("And me?", undefined, second);

    expect(await heldTexts(world)).toEqual(["Second."]);
  });

  it("goes with a thread a merge closes, and doesn't come back with an undo", async () => {
    const world = await instance([
      replies("First.", "general", [generalSource]),
      replies("Second.", "general", [generalSource]),
      quiet(),
      quiet(),
    ]);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await world.hears("Hello");
    const [absorbed] = await world.rpc.representative.threadList({ id: world.id });
    await world.hears("Hello", undefined, "+15550003");
    const lines = await world.rpc.representative.threadList({ id: world.id });
    const survivor = lines.find(({ customer }) => customer.id !== absorbed!.customer.id)!;

    await world.rpc.representative.customerMerge({
      id: absorbed!.customer.id,
      intoId: survivor.customer.id,
    });
    const [merge] = await world.rpc.representative.customerMergeList();
    await world.rpc.representative.customerMergeUndo({ id: merge!.id });

    const { held } = await world.rpc.representative.threadGet({ id: absorbed!.id });
    expect(held).toEqual([]);
  });

  it("keeps its thread open and waiting on the owner, who was told to send or drop it", async () => {
    const world = await instance([
      replies("First.", "general", [generalSource]),
      replies("Second.", "general", [generalSource]),
      quiet(),
    ]);
    await world.rpc.representative.setCaps({ id: world.id, maxInARow: 1 });
    await world.hears("Hello");
    const [line] = await world.rpc.representative.threadList({ id: world.id });
    expect(line!.waitingOn).toBe("owner");

    world.timer.advance(threadIdleMs * 2);
    world.timer.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { held } = await world.rpc.representative.threadGet({ id: line!.id });
    await expect(
      world.rpc.representative.threadHeldSend({ id: held[0]!.id }),
    ).resolves.toBeTruthy();
  });
});

/** The owner's `Hours` topic promoted to auto-send, with a fact on it and one on `Prices`. */
async function promotedHours(rounds: Round[]) {
  const world = await instance(rounds);
  const { rpc } = world;
  await rpc.representative.factAdd({ key: "hours", type: "text", topic: "Hours", value: "9 to 5" });
  await rpc.representative.factAdd({
    key: "tax",
    type: "text",
    topic: "Prices",
    value: "Included",
  });
  const { id } = await rpc.representative.topicAdd({ name: "Hours" });
  await rpc.representative.topicSetMode({ id, mode: "auto" });
  return { ...world, topicId: id };
}

const hours = { type: "fact", key: "hours" };
const tax = { type: "fact", key: "tax" };
const answersOn = (sources: object[], topic = "hours") =>
  round(
    toolCall({ name: "reply", input: { text: "We are open.", kind: "answer", topic, sources } }),
  );

describe("a reply on an auto topic", () => {
  it("is sent when every source is a fact of that topic", async () => {
    const world = await promotedHours([answersOn([hours]), quiet()]);

    await world.hears("When are you open?");

    await expect.poll(world.got, poll).toEqual(["We are open."]);
    expect(await world.decisions()).toEqual([["reply", "send", "passed"]]);
  });

  it("is a draft when a source is a fact of another topic", async () => {
    for (const sources of [[tax], [hours, tax]]) {
      const world = await promotedHours([answersOn(sources), quiet()]);

      await world.hears("When are you open?");

      await expect.poll(world.got, poll).toEqual([holdingNote]);
      expect(await world.decisions()).toEqual([
        ["reply", "hold", "topic"],
        ["holding_note", "send", "passed"],
      ]);
    }
  });

  it("is a draft when it has no sources, whatever the kind", async () => {
    const world = await promotedHours([replies("Hi there.", "Hours"), quiet()]);

    await world.hears("Hello");

    await expect.poll(world.got, poll).toEqual([holdingNote]);
    expect(await world.decisions()).toEqual([
      ["reply", "hold", "topic"],
      ["holding_note", "send", "passed"],
    ]);
  });

  it("is a draft when a source is a document, an Assignment's result or the Customer's memory", async () => {
    const world = await promotedHours([quiet()]);
    await world.hears("Hello");
    const threadId = await world.threadId();
    const content = (sources: object[]) => ({
      text: "We are open.",
      verified: true,
      replyKind: "answer" as const,
      topic: "Hours",
      sources: sources as never,
    });
    const decide = (sources: object[]) =>
      getTestDb().transaction((tx) =>
        passGate(tx, {
          kind: "reply",
          channel: noCustomerChannel,
          threadId,
          to: { channel: "fake", externalId: number },
          now: world.timer.clock.now(),
          content: content(sources),
        }),
      );

    expect(await decide([hours])).toMatchObject({ outcome: "send" });
    for (const source of [
      { type: "document", name: "menu", quote: "9 to 5" },
      { type: "assignment", assignmentId: crypto.randomUUID(), quote: "9 to 5" },
      { type: "memory", quote: "9 to 5" },
    ]) {
      expect(await decide([hours, source])).toMatchObject({ outcome: "hold", rule: "topic" });
    }
  });
});

describe("promoting a topic", () => {
  it("is the owner's action alone: another owner can't, and a Model's label changes nothing", async () => {
    const world = await instance([replies("Hi.", "Hours", [generalSource]), quiet()]);
    const { id } = await world.rpc.representative.topicAdd({ name: "Hours" });
    const other = chatRpc({ user: await insertUser(), deps: world.deps });

    await expect(other.representative.topicSetMode({ id, mode: "auto" })).rejects.toSatisfy(
      (error) => refusalCode(error) === "error.topicNotFound",
    );
    await world.hears("Hello");
    await expect.poll(world.got, poll).toEqual([holdingNote]);

    const topics = await world.rpc.representative.topicList();
    expect(topics.find(({ name }) => name === "Hours")).toMatchObject({ mode: "draft" });
  });

  it("can be undone by the owner, and the topic waits for them again", async () => {
    const world = await promotedHours([answersOn([hours]), quiet()]);
    await world.rpc.representative.topicSetMode({ id: world.topicId, mode: "draft" });

    await world.hears("When are you open?");

    await expect.poll(world.got, poll).toEqual([holdingNote]);
  });
});

describe("suggesting a promotion", () => {
  it("shows after the twentieth unedited approval, and the topic stays draft", async () => {
    const turns = 21;
    const world = await instance(
      Array.from({ length: turns }, () => [replies("It is fine.", "billing"), quiet()]).flat(),
    );
    await world.rpc.representative.topicAdd({ name: "Billing" });
    const suggestion = async () => (await world.rpc.representative.topicList())[0]!;
    const next = async (index: number, answer: (id: string) => Promise<unknown>) => {
      // Each its own Customer: one gets at most 20 messages a day.
      await world.hears(`Question ${index}`, undefined, `+155500${index}`);
      await expect.poll(async () => (await world.drafts()).length, poll).toBe(1);
      await answer((await world.drafts())[0]!.id);
      await expect.poll(async () => (await world.drafts()).length, poll).toBe(0);
    };

    // An edited approval isn't counted.
    await next(0, (id) => world.rpc.representative.replyDraftEdit({ id, text: "Edited." }));
    for (let index = 1; index < 20; index += 1) {
      await next(index, (id) => world.rpc.representative.replyDraftApprove({ id }));
    }
    expect(await suggestion()).toMatchObject({ approvedUnedited: 19, promotionSuggested: false });

    await next(20, (id) => world.rpc.representative.replyDraftApprove({ id }));

    expect(await suggestion()).toMatchObject({
      mode: "draft",
      approvedUnedited: 20,
      promotionSuggested: true,
    });
  });
});

describe("a draft past its due time", () => {
  const pages = () => getTestDb().select().from(page);
  const settle = async (world: World, ms: number) => {
    world.timer.advance(ms);
    world.timer.tick();
    await new Promise((resolve) => setTimeout(resolve, 500));
  };

  it("Pages the owner once, and not before", async () => {
    const { world } = await oneDraft();

    await settle(world, draftDueMs - 60_000);
    expect(await pages()).toEqual([]);

    await settle(world, 120_000);
    await expect.poll(async () => (await pages()).length, poll).toBe(1);
    expect(await pages()).toMatchObject([
      { userId: world.user.id, cause: "reply_draft_due", urgency: "routine" },
    ]);
  });

  it("Pages nobody once the owner has answered it", async () => {
    const { world, draftId } = await oneDraft();
    await world.rpc.representative.replyDraftReject({ id: draftId });

    await settle(world, draftDueMs * 2);

    expect(await pages()).toEqual([]);
  });
});
