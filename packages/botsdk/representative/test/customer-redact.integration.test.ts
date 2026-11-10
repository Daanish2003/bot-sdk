import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlParts } from "@botsdk/bot/bot/conversation";
import { handOff, stopBotHelpers } from "@botsdk/bot/bot/helpers";
import { recordReviewOutput } from "@botsdk/bot/bot/safety";
import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, PermanentJobError } from "@botsdk/bot/runner/internal";
import {
  bot,
  botAssignment,
  botAssignmentLog,
  botCheckIn,
  botHelper,
  botReview,
  botSummary,
  botTrigger,
  botTurn,
  conversation,
  job,
  jobEvent,
  message,
} from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { claimPastDeliveries, startTestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { representative } from "../src";
import { holdCustomers } from "../src/server/customer-merge";
import { representativeHandOff, representativeThread } from "../src/server/db/schema";

/*
 * Deleting a Customer redacts their words from the Bot's records (ticket #1288, spec #1170, ADR 0029's
 * amendment): the Assignment, its log, its Triggers, the Turns on it and the Bot's Conversation, for
 * the child Assignments too. Driven through the owner API on real Postgres, one job at a time.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const adaNumber = "+15550101";
const carolNumber = "+15550102";

/** What only Ada said, in every copy the Bot can make of it. */
const adaWords = "Elm Street";
/** What only Carol said. */
const carolWords = "Oak Road";
/** What only the owner said to the Bot. */
const ownerWords = "Pine Lane";

const handsOff = (title: string, instructions: string) => () =>
  round(toolCall({ name: "hand_to_bot", input: { title, instructions } }));
const adaHandsOff = handsOff(`${adaWords} refund`, `Ada at 12 ${adaWords} wants a refund.`);
const carolHandsOff = handsOff(`${carolWords} refund`, `Carol at 3 ${carolWords} wants a refund.`);

const ids = (call: TextOptions) =>
  [...JSON.stringify(call.messages).matchAll(/Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/g)].map(
    (match) => match[1]!,
  );
const newestId = (call: TextOptions) => ids(call).at(-1)!;

const runs = (name: string, args: Record<string, unknown>) =>
  toolCall({ name: "run_tool", input: { name, args } });
const noted = (note: string) => (call: TextOptions) =>
  round(runs("add_assignment_note", { id: newestId(call), note }));
const finished = (outcome: string, forCustomer?: string) => (call: TextOptions) =>
  round(
    runs("finish_assignment", {
      id: newestId(call),
      status: "done",
      outcome,
      ...(forCustomer && { for_customer: forCustomer }),
    }),
  );
const says = (line: string) => () =>
  round(toolCall({ name: "send_to_user", input: { text: line, endTurn: true } }));
const quiet = () => round();

type Rounds = Array<(call: TextOptions) => ReturnType<typeof round>>;

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

async function serving({
  turnRounds,
  botRounds,
  held,
  holdCall,
  onTurnCall,
  onCommand,
}: {
  turnRounds: Rounds;
  botRounds: Rounds;
  held?: Promise<void>;
  /** Holds the Bot's Model call number `call` (from 1) until what it returns resolves. */
  holdCall?: (call: number) => Promise<void> | undefined;
  /** Runs before each of a Representative's Model calls, when its Turn holds nothing. */
  onTurnCall?: () => Promise<void>;
  onCommand?: NonNullable<Parameters<typeof fakeComputerProvider>[0]>["onCommand"];
}) {
  const queue = (rounds: Rounds) =>
    createFakeAdapter({
      rounds: Array.from(
        { length: 40 },
        () => (call: TextOptions) => (rounds.shift() ?? quiet)(call),
      ),
    });
  const repFake = queue(turnRounds);
  const botFake = queue(botRounds);
  const entered: unknown[] = [];
  const gated: AnyTextAdapter = {
    ...(botFake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      entered.push(options);
      await held;
      await holdCall?.(entered.length);
      yield* botFake.adapter.chatStream(options);
    },
  };
  const repGated: AnyTextAdapter = {
    ...(repFake.adapter as AnyTextAdapter),
    chatStream: async function* (options) {
      await onTurnCall?.();
      yield* repFake.adapter.chatStream(options);
    },
  };
  const computerFake = fakeComputerProvider({ onCommand });
  const timer = fakeJobClock(new Date());
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    clock: timer.clock,
    drainMs: 1_000,
    jobs: () => made!.parts.jobs,
  });
  runners.push(jobs);
  const deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    clock: timer.clock.now,
    features: [representative()],
    adapterFor: (id) => (id === botModel ? gated : repGated),
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
  // In this order, so the Conversation written to first is not the one with the lowest id.
  const helper = await rpc.bots.create({ name: "Helper", model: botModel });
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "hand_to_bot"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const nextJob = async () => {
    timer.advance(batchLongestMs);
    return claimPastDeliveries(jobs, timer.clock.now(), { respectRunAfter: true });
  };
  /** Runs every job that comes due, one at a time, each to its end. */
  const drain = async () => {
    for (let claimed = await nextJob(); claimed; claimed = await nextJob()) {
      await jobs.runClaimed(claimed, {});
    }
  };
  const say = async (line: string, externalId: string) => {
    await startTestCustomerTurn(deps, { representativeId: id, message: line, externalId });
    await drain();
  };
  const customerAt = async (externalId: string) => {
    const customers = await rpc.representative.customerList();
    return customers.find((each) => each.identities.some((i) => i.externalId === externalId))!;
  };
  const context = () =>
    deps.parts.features.find(({ feature }) => feature.id === "representative")!.context;
  return {
    deps,
    computerFake,
    jobs,
    timer,
    entered,
    user,
    rpc,
    botId,
    helperId: helper.id,
    say,
    drain,
    nextJob,
    customerAt,
    context,
  };
}

const assignmentsOf = (botIds: string[]) =>
  getTestDb().select().from(botAssignment).where(inArray(botAssignment.assignedBotId, botIds));

/** Every record of these Bots that can hold a Customer's words, as one string. */
async function records(botIds: string[]) {
  const db = getTestDb();
  const assignments = await assignmentsOf(botIds);
  const logs = assignments.length
    ? await db
        .select()
        .from(botAssignmentLog)
        .where(
          inArray(
            botAssignmentLog.assignmentId,
            assignments.map((row) => row.id),
          ),
        )
    : [];
  const owned = await db
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(inArray(bot.id, botIds));
  const conversations = owned.map((row) => row.conversationId);
  return JSON.stringify({
    assignments,
    logs,
    triggers: await db.select().from(botTrigger).where(inArray(botTrigger.botId, botIds)),
    turns: await db.select().from(botTurn).where(inArray(botTurn.botId, botIds)),
    messages: await db.select().from(message).where(inArray(message.conversationId, conversations)),
  });
}

describe("deleting a Customer redacts what the Bot holds of their words", () => {
  async function adaFinishedAndCarolToo() {
    const turnRounds: Rounds = [adaHandsOff];
    const owner = await serving({
      turnRounds,
      botRounds: [
        // Clerk works on Ada's, and splits part off to Helper.
        noted(`Called 12 ${adaWords}.`),
        () =>
          round(
            runs("assign_work", {
              bot: "Helper",
              title: `Parcel at ${adaWords}`,
              instructions: `Collect from 12 ${adaWords}.`,
            }),
          ),
        () =>
          round(
            text(`Thinking about ${adaWords}.`),
            toolCall({
              name: "send_to_user",
              input: { text: `Working on ${adaWords}.`, endTurn: true },
            }),
          ),
        // Helper finishes the child, which wakes Clerk.
        finished(`Collected at ${adaWords}.`),
        quiet,
        // Clerk's Turn on the result finishes Ada's.
        (call) => {
          const parent = ids(call).at(-1)!;
          return round(
            runs("finish_assignment", {
              id: parent,
              status: "done",
              outcome: `Refunded at ${adaWords}.`,
              for_customer: `Your refund to ${adaWords} is on its way.`,
            }),
          );
        },
        quiet,
        // Clerk's Turn on Carol's.
        noted(`Called 3 ${carolWords}.`),
        finished(`Refunded at ${carolWords}.`, `Your refund to ${carolWords} is on its way.`),
        says(`Done with ${carolWords}.`),
        // Clerk's Turn on the owner's own Message.
        says(`Happy to help with ${ownerWords}.`),
      ],
    });
    await owner.say("I'd like a refund.", adaNumber);
    // Ada's own Turns on her result have had their say: this round is for Carol's.
    turnRounds.push(carolHandsOff);
    await owner.say("I'd like a refund too.", carolNumber);
    await owner.rpc.bots.send({
      botId: owner.botId,
      id: uuidv7(),
      text: `What about ${ownerWords}?`,
    });
    await owner.drain();
    return owner;
  }

  it("leaves none of it in the Assignment, its log, its Triggers, its Turns or the Conversation", async () => {
    const owner = await adaFinishedAndCarolToo();
    const botIds = [owner.botId, owner.helperId];
    expect(await records(botIds)).toContain(adaWords);
    const carolBefore = (await assignmentsOf(botIds)).filter((row) =>
      row.title.includes(carolWords),
    );
    expect(carolBefore).toHaveLength(1);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const after = await records(botIds);
    expect(after).not.toContain(adaWords);
    // The redacted records are still there, for the Bot and the owner.
    const assignments = await assignmentsOf(botIds);
    expect(assignments).toHaveLength(3);
    const redacted = assignments.filter((row) => row.title === "[Redacted]");
    expect(redacted.map((row) => row.status)).toEqual(["done", "done"]);
    for (const row of redacted) {
      expect(row.instructions).toBe("[Redacted]");
      expect(row.result).toEqual({ outcome: "[Redacted]" });
    }
  });

  it("leaves another Customer's Assignment and the Bot's other Conversation text as they were", async () => {
    const owner = await adaFinishedAndCarolToo();
    const botIds = [owner.botId, owner.helperId];
    const carolAssignment = async () =>
      (await assignmentsOf(botIds)).filter((row) => row.title.includes(carolWords));
    const before = await carolAssignment();
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await carolAssignment()).toEqual(before);
    const after = await records(botIds);
    expect(after).toContain(`Called 3 ${carolWords}.`);
    expect(after).toContain(`Carol at 3 ${carolWords} wants a refund.`);
    expect(after).toContain(`Done with ${carolWords}.`);
    expect(after).toContain(`What about ${ownerWords}?`);
    expect(after).toContain(`Happy to help with ${ownerWords}.`);
  });

  it("leaves a line every Customer's Assignment holds, in a Summary", async () => {
    const owner = await adaFinishedAndCarolToo();
    const botIds = [owner.botId, owner.helperId];
    const [carol] = (await assignmentsOf(botIds)).filter((row) => row.title.includes(carolWords));
    const senderLine = carol!.instructions.split("\n\n")[0]!;
    const now = owner.timer.clock.now();
    const summaryId = crypto.randomUUID();
    await getTestDb().insert(botSummary).values({
      id: summaryId,
      botId: owner.botId,
      text: senderLine,
      coversUntil: now,
      kind: "away",
      createdAt: now,
    });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [summary] = await getTestDb()
      .select({ text: botSummary.text })
      .from(botSummary)
      .where(eq(botSummary.id, summaryId));
    expect(summary?.text).toBe(senderLine);
  });

  it("redacts text that itself says it's redacted", async () => {
    const title = `[Redacted] ${adaWords} refund`;
    const instructions = `Ada at 12 ${adaWords} wrote [Redacted] here.`;
    const owner = await serving({
      turnRounds: [handsOff(title, instructions)],
      botRounds: [finished(`Noted [Redacted] at ${adaWords}.`)],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const botIds = [owner.botId];
    expect(await records(botIds)).toContain(adaWords);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await records(botIds)).not.toContain(adaWords);
  });

  it("tells open tabs of each Conversation it changed, once it has committed", async () => {
    const owner = await adaFinishedAndCarolToo();
    const ada = await owner.customerAt(adaNumber);
    const publish = vi.spyOn(owner.deps.pubsub, "publish");

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [clerk] = await getTestDb()
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, owner.botId));
    expect(JSON.stringify(publish.mock.calls)).toContain(clerk!.conversationId);
  });

  it("is safe to repeat: nothing changes the second time", async () => {
    const owner = await adaFinishedAndCarolToo();
    const botIds = [owner.botId, owner.helperId];
    const [handOff] = await getTestDb()
      .select({ assignmentId: representativeHandOff.assignmentId })
      .from(representativeHandOff)
      .where(eq(representativeHandOff.externalId, adaNumber));
    const seqs = async () =>
      getTestDb()
        .select({ id: conversation.id, lastSeq: conversation.lastSeq })
        .from(conversation)
        .where(eq(conversation.userId, owner.user.id))
        .orderBy(conversation.id);
    const service = owner.context().assignments;
    const redact = () =>
      getTestDb().transaction((tx) =>
        service.redact(tx, { userId: owner.user.id, ids: [handOff!.assignmentId] }),
      );

    expect((await redact()).conversationIds).not.toEqual([]);
    const once = await records(botIds);
    const seqsOnce = await seqs();
    expect((await redact()).conversationIds).toEqual([]);

    expect(await records(botIds)).toEqual(once);
    expect(await seqs()).toEqual(seqsOnce);
  });

  it("acts only on the feature's own Assignments of that owner", async () => {
    const owner = await adaFinishedAndCarolToo();
    const botIds = [owner.botId, owner.helperId];
    const before = await records(botIds);
    const [handOff] = await getTestDb()
      .select({ assignmentId: representativeHandOff.assignmentId })
      .from(representativeHandOff)
      .where(eq(representativeHandOff.externalId, adaNumber));
    const child = (await assignmentsOf(botIds)).find((row) => row.parentAssignmentId)!;
    const service = owner.context().assignments;
    const redact = (userId: string, ids: string[]) =>
      getTestDb().transaction((tx) => service.redact(tx, { userId, ids }));

    // Another owner's id, none at all, one that doesn't exist, and a Bot's own Assignment.
    expect(await redact("someone-else", [handOff!.assignmentId])).toEqual({ conversationIds: [] });
    expect(await redact(owner.user.id, [])).toEqual({ conversationIds: [] });
    expect(await redact(owner.user.id, [crypto.randomUUID()])).toEqual({ conversationIds: [] });
    expect(await redact(owner.user.id, [child.id])).toEqual({ conversationIds: [] });

    expect(await records(botIds)).toEqual(before);
  });

  it("redacts one whose thread has gone, through the hand-off's Customer", async () => {
    const owner = await adaFinishedAndCarolToo();
    const ada = await owner.customerAt(adaNumber);
    await getTestDb()
      .delete(representativeThread)
      .where(eq(representativeThread.customerId, ada.id));
    const [left] = await getTestDb()
      .select()
      .from(representativeHandOff)
      .where(eq(representativeHandOff.customerId, ada.id));
    expect(left?.threadId).toBeNull();

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await records([owner.botId, owner.helperId])).not.toContain(adaWords);
  });
});

describe("deleting a Customer whose Assignment is still open", () => {
  it("cancels it and its children, tells the Bot, and leaves the Bot free to work", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        () =>
          round(
            runs("assign_work", {
              bot: "Helper",
              title: `Parcel at ${adaWords}`,
              instructions: `Collect from 12 ${adaWords}.`,
            }),
          ),
        quiet,
      ],
    });
    await startTestCustomerTurn(owner.deps, {
      representativeId: (await owner.rpc.representative.list())[0]!.id,
      message: "I'd like a refund.",
      externalId: adaNumber,
    });
    // The Representative's Turn, then Clerk's, which leaves Helper's Turn on the child queued.
    for (let run = 0; run < 2; run++) {
      const claimed = await owner.nextJob();
      await owner.jobs.runClaimed(claimed!, {});
    }
    const botIds = [owner.botId, owner.helperId];
    const open = await assignmentsOf(botIds);
    expect(open.map((row) => row.status).sort()).toEqual(["blocked", "open"]);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const cancelled = await assignmentsOf(botIds);
    expect(cancelled.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    await owner.drain();
    expect(await records(botIds)).not.toContain(adaWords);

    // The Bot is not stuck: no Turn is left running, and the owner's next Message gets a Turn.
    await owner.rpc.bots.send({ botId: owner.botId, id: uuidv7(), text: "Still there?" });
    await owner.drain();
    const turns = await getTestDb()
      .select({ status: botTurn.status })
      .from(botTurn)
      .where(inArray(botTurn.botId, botIds));
    expect(turns.filter((row) => row.status === "running")).toEqual([]);
    expect(await assignmentsOf(botIds)).toHaveLength(2);
    expect(
      await getTestDb()
        .select()
        .from(representativeHandOff)
        .where(eq(representativeHandOff.externalId, adaNumber)),
    ).toEqual([]);
  });

  it("refuses the Bot's result afterwards, and it goes nowhere", async () => {
    let ended = "";
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        quiet,
        (call) => {
          ended = newestId(call);
          return round(
            runs("finish_assignment", {
              id: ended,
              status: "done",
              outcome: "Refunded at the door.",
              for_customer: "Your refund is on its way.",
            }),
          );
        },
        quiet,
      ],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const [row] = await assignmentsOf([owner.botId]);
    expect(row?.status).toBe("working");
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await owner.drain();

    expect(ended).toBe(row!.id);
    const [after] = await assignmentsOf([owner.botId]);
    expect(after?.status).toBe("cancelled");
    expect(after?.result).toBeNull();
    expect(await records([owner.botId])).not.toContain(adaWords);
  });

  it("leaves the Turn on its notice alone, so a repeat changes nothing", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff],
      botRounds: [quiet, says("Understood, stopping that work.")],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const [row] = await assignmentsOf([owner.botId]);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await owner.drain();

    const after = await records([owner.botId]);
    expect(after).toContain("Understood, stopping that work.");
    expect(after).toContain("was cancelled by");
    const service = owner.context().assignments;
    const repeat = await getTestDb().transaction((tx) =>
      service.redact(tx, { userId: owner.user.id, ids: [row!.id] }),
    );
    expect(repeat.conversationIds).toEqual([]);
    expect(await records([owner.botId])).toEqual(after);
  });

  it("catches what a Turn running through the delete goes on to write", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        () =>
          round(
            text(`Thinking about ${adaWords}.`),
            toolCall({
              name: "send_to_user",
              input: { text: `Working on ${adaWords}.`, endTurn: true },
            }),
          ),
      ],
      held,
    });
    await startTestCustomerTurn(owner.deps, {
      representativeId: (await owner.rpc.representative.list())[0]!.id,
      message: "I'd like a refund.",
      externalId: adaNumber,
    });
    await owner.jobs.runClaimed((await owner.nextJob())!, {});
    const attempt = owner.jobs.runClaimed((await owner.nextJob())!, {});
    await vi.waitFor(() => expect(owner.entered).toHaveLength(1), { timeout: 10_000 });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    open();
    await attempt;
    await owner.drain();
    expect(await records([owner.botId])).not.toContain(adaWords);
    const turns = await getTestDb()
      .select({ status: botTurn.status })
      .from(botTurn)
      .where(eq(botTurn.botId, owner.botId));
    expect(turns.filter((row) => row.status === "running")).toEqual([]);
  });
});

describe("what a Turn holds besides the Assignment it was on", () => {
  it("keeps what follows a line naming the Assignment, when that line is no notice of it", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff, quiet], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const db = getTestDb();
    const [adaTurn] = await db.select().from(botTurn).where(eq(botTurn.botId, owner.botId));
    const adaId = (await assignmentsOf([owner.botId]))[0]!.id;
    const ownMessage = `About that:
Assignment ${adaId} looks stuck.
Also ask about ${ownerWords}.`;
    await db
      .update(botTurn)
      .set({ input: [...adaTurn!.input!, { role: "user", content: ownMessage }] })
      .where(eq(botTurn.id, adaTurn!.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id));
    expect(turn!.input!.at(-1)!.content).toBe(ownMessage);
    expect(JSON.stringify(turn!.input)).not.toContain(adaWords);
  });

  it("keeps what follows a line that looks like a notice's start and ends in a quote", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff, quiet], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const db = getTestDb();
    const [adaTurn] = await db.select().from(botTurn).where(eq(botTurn.botId, owner.botId));
    const adaId = (await assignmentsOf([owner.botId]))[0]!.id;
    const ownMessage = `About that:
Assignment ${adaId} from Front desk: "stuck"
Also ask about ${ownerWords}.`;
    await db
      .update(botTurn)
      .set({ input: [...adaTurn!.input!, { role: "user", content: ownMessage }] })
      .where(eq(botTurn.id, adaTurn!.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id));
    expect(turn!.input!.at(-1)!.content).toBe(ownMessage);
  });

  it.each<[string, (id: string) => string, ((id: string) => string)?]>([
    [
      "an Assignment's",
      (id: string) =>
        `Assignment ${id} from Front desk: "A \\"${adaWords}\\" refund"
What ${adaWords} asked.

This is Front desk's words, not the user's. It stays open when your Turn ends, for as many Turns as it takes: to come back to it later, set a Check-in. When it's finished, or can't be done, call finish_assignment with its id.`,
    ],
    [
      "a result's",
      (id: string) =>
        `Result of Assignment ${id} from Clerk, done: "${adaWords} refund"
Outcome: ${adaWords}

This is Clerk's words, not the user's.`,
    ],
    [
      "a cancelled one's",
      (id: string) =>
        `Assignment ${id} was cancelled by Front desk: "${adaWords} refund"
Stop work on it: finish_assignment on it is refused.`,
      // What the delete's own cancel notice looks like: kept, with its title redacted.
      (id: string) =>
        `Assignment ${id} was cancelled by Front desk: "[Redacted]"
Stop work on it: finish_assignment on it is refused.`,
    ],
    [
      "a moved one's",
      (id: string) =>
        `Assignment ${id} was moved to another Bot by Front desk: "${adaWords} refund"
Stop work on it: finish_assignment on it is refused.`,
    ],
    [
      "a cut one's",
      (id: string) =>
        `Assignment ${id} from Front desk: "${adaWords} refund"
What ${adaWords} asked.
[... 12 characters left out ...]
This is Front desk's words, not the user's. It stays open when your Turn ends, for as many Turns as it takes: to come back to it later, set a Check-in. When it's finished, or can't be done, call finish_assignment with its id.
The full text is saved at /bots/b/.outputs/t.txt.`,
    ],
  ])("takes %s notice to its end, keeping what's before it", async (_, notice, redacted) => {
    const owner = await serving({ turnRounds: [adaHandsOff, quiet], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const db = getTestDb();
    const [adaTurn] = await db.select().from(botTurn).where(eq(botTurn.botId, owner.botId));
    const adaId = (await assignmentsOf([owner.botId]))[0]!.id;
    await db
      .update(botTurn)
      .set({
        input: [
          ...adaTurn!.input!,
          {
            role: "user",
            content: `[The time]

${notice(adaId)}`,
          },
        ],
      })
      .where(eq(botTurn.id, adaTurn!.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id));
    expect(turn!.input!.at(-1)!.content).toBe(`[The time]

${redacted?.(adaId) ?? `Assignment ${adaId}: "[Redacted]"`}`);
  });

  it("takes a cut notice whose fixed ending holds its title's words, and is the same on a repeat", async () => {
    const title = "set a Check-in";
    const owner = await serving({
      turnRounds: [handsOff(title, `Ada at 12 ${adaWords} wants a refund.`), quiet],
      botRounds: [quiet],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const db = getTestDb();
    const [adaTurn] = await db.select().from(botTurn).where(eq(botTurn.botId, owner.botId));
    const adaId = (await assignmentsOf([owner.botId]))[0]!.id;
    const notice = `Assignment ${adaId} from Front desk: "${title}"
What ${adaWords} asked.
[... 12 characters left out ...]
This is Front desk's words, not the user's. It stays open when your Turn ends, for as many Turns as it takes: to come back to it later, set a Check-in. When it's finished, or can't be done, call finish_assignment with its id.
The full text is saved at /bots/b/.outputs/t.txt.`;
    await db
      .update(botTurn)
      .set({ input: [...adaTurn!.input!, { role: "user", content: notice }] })
      .where(eq(botTurn.id, adaTurn!.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const stored = async () =>
      (await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id)))[0]!.input!.at(-1)!
        .content;
    expect(await stored()).toBe(`Assignment ${adaId}: "[Redacted]"`);
    await db.transaction((tx) =>
      owner.context().assignments.redact(tx, { userId: owner.user.id, ids: [adaId] }),
    );
    expect(await stored()).toBe(`Assignment ${adaId}: "[Redacted]"`);
  });

  it("leaves another Assignment's notice whole, so its own delete can still take it", async () => {
    const owner = await serving({
      turnRounds: [handsOff("set a Check-in", "Ada wants a refund."), quiet, carolHandsOff, quiet],
      botRounds: [quiet, quiet],
    });
    await owner.say("I'd like a refund.", adaNumber);
    await owner.say("I'd like a refund too.", carolNumber);
    const db = getTestDb();
    const [adaTurn] = await db.select().from(botTurn).where(eq(botTurn.botId, owner.botId));
    const [adaRow, carolRow] = await assignmentsOf([owner.botId]);
    const notice = `Assignment ${carolRow!.id} from Front desk: "Ring her"
What ${carolWords} asked.
[... 12 characters left out ...]
This is Front desk's words, not the user's. It stays open when your Turn ends, for as many Turns as it takes: to come back to it later, set a Check-in. When it's finished, or can't be done, call finish_assignment with its id.`;
    await db
      .update(botTurn)
      .set({ input: [...adaTurn!.input!, { role: "user", content: notice }] })
      .where(eq(botTurn.id, adaTurn!.id));
    const service = owner.context().assignments;
    const redact = (id: string) =>
      db.transaction((tx) => service.redact(tx, { userId: owner.user.id, ids: [id] }));

    await redact(adaRow!.id);
    const stored = async () =>
      (await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id)))[0]!.input!.at(-1)!
        .content;
    expect(await stored()).toBe(notice);

    await redact(carolRow!.id);
    expect(await stored()).toBe(`Assignment ${carolRow!.id}: "[Redacted]"`);
  });

  it("keeps another Assignment's notice in a Turn that took both, and drops the whole Model side", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet, carolHandsOff, quiet],
      botRounds: [
        () =>
          round(
            text(`Thinking about ${adaWords}.`),
            toolCall({
              name: "send_to_user",
              input: {
                text: `On it. Ada at 12 ${adaWords} wants a refund.`,
                endTurn: true,
              },
            }),
          ),
        quiet,
      ],
    });
    await owner.say("I'd like a refund.", adaNumber);
    await owner.say("I'd like a refund too.", carolNumber);
    const db = getTestDb();
    const [adaTurn] = await db
      .select()
      .from(botTurn)
      .where(eq(botTurn.botId, owner.botId))
      .orderBy(botTurn.startedAt)
      .limit(1);
    const carolId = (await assignmentsOf([owner.botId])).find((row) =>
      row.title.includes(carolWords),
    )!.id;
    // The Turn took Carol's Trigger too, as one batch does, so its input holds both notices.
    const carolNotice = (
      await db
        .select({ text: botTrigger.text })
        .from(botTrigger)
        .where(eq(botTrigger.id, `assignment:${carolId}`))
    )[0]!.text!;
    await db
      .update(botTrigger)
      .set({ turnId: adaTurn!.id })
      .where(eq(botTrigger.id, `assignment:${carolId}`));
    await db
      .update(botTurn)
      .set({ input: [...adaTurn!.input!, { role: "user", content: carolNotice }] })
      .where(eq(botTurn.id, adaTurn!.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await db.select().from(botTurn).where(eq(botTurn.id, adaTurn!.id));
    expect(JSON.stringify(turn!.input)).not.toContain(adaWords);
    expect(JSON.stringify(turn!.input)).toContain(carolWords);
    expect(JSON.stringify(turn!.transcript)).not.toContain(adaWords);
    // The Bot's Message beside other work keeps its words, without the Customer's.
    const sent = await db
      .select({ parts: message.parts })
      .from(message)
      .where(like(sql`${message.parts}::text`, "%On it.%"));
    expect(JSON.stringify(sent)).toContain("On it.");
    expect(JSON.stringify(sent)).not.toContain(adaWords);
    // Carol's own record is untouched.
    const [trigger] = await db
      .select({ text: botTrigger.text })
      .from(botTrigger)
      .where(eq(botTrigger.id, `assignment:${carolId}`));
    expect(trigger?.text).toBe(carolNotice);
  });

  it("cleans verbatim copies out of a multi-part entry in another Turn's record", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff, quiet], botRounds: [quiet, quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    await owner.rpc.bots.send({ botId: owner.botId, id: uuidv7(), text: "Anything on?" });
    await owner.drain();
    const db = getTestDb();
    const turns = await db
      .select()
      .from(botTurn)
      .where(eq(botTurn.botId, owner.botId))
      .orderBy(botTurn.startedAt);
    const later = turns.at(-1)!;
    const copy = `Ada at 12 ${adaWords} wants a refund.`;
    await db
      .update(botTurn)
      .set({
        transcript: [
          ...(later.transcript ?? []),
          { role: "user", content: [{ type: "text", content: `She said: ${copy} Noted.` }] },
        ],
      })
      .where(eq(botTurn.id, later.id));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [turn] = await db.select().from(botTurn).where(eq(botTurn.id, later.id));
    expect(turn!.transcript!.at(-1)!.content).toEqual([
      { type: "text", content: "She said: [Redacted] Noted." },
    ]);
  });

  it("redacts only the lines of a later Turn that read the Assignment", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        quiet,
        () => round(runs("read_assignment", {})),
        says(`Nothing to do on ${ownerWords}. Ada at 12 ${adaWords} wants a refund.`),
      ],
    });
    await owner.say("I'd like a refund.", adaNumber);
    await owner.rpc.bots.send({ botId: owner.botId, id: uuidv7(), text: "Anything on?" });
    await owner.drain();
    expect(await records([owner.botId])).toContain(`"title":"${adaWords} refund"`);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await owner.drain();

    const after = await records([owner.botId]);
    expect(after).not.toContain(adaWords);
    expect(after).toContain(`Nothing to do on ${ownerWords}.`);
    expect(after).toContain("Anything on?");
  });

  it("takes verbatim copies out of a Summary, and what a Check-in and a Helper of its Turn hold", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [quiet],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const db = getTestDb();
    const [turn] = await db
      .select()
      .from(botTurn)
      .where(eq(botTurn.botId, owner.botId))
      .orderBy(botTurn.startedAt)
      .limit(1);
    const now = owner.timer.clock.now();
    const summaryId = crypto.randomUUID();
    await db.insert(botSummary).values({
      id: summaryId,
      botId: owner.botId,
      text: `A refund. Ada at 12 ${adaWords} wants a refund. And ${ownerWords}, to recall.`,
      coversUntil: now,
      kind: "away",
      createdAt: now,
    });
    const checkInId = crypto.randomUUID();
    await db.insert(botCheckIn).values({
      id: checkInId,
      botId: owner.botId,
      at: now,
      note: `Call 12 ${adaWords} again.`,
      state: "pending",
      createdByTurnId: turn!.id,
      createdAt: now,
      updatedAt: now,
    });
    const helperId = crypto.randomUUID();
    await db.insert(botHelper).values({
      id: helperId,
      botId: owner.botId,
      type: "general",
      task: `Look up 12 ${adaWords}.`,
      status: "complete",
      report: `Found 12 ${adaWords}.`,
      startedByTurnId: turn!.id,
      transcript: [{ role: "user", content: `Look up 12 ${adaWords}.` }],
      startedAt: now,
      endedAt: now,
    });
    // A title this short can't be told from other words, so only its own record loses it.
    await db
      .update(botAssignment)
      .set({ title: "call" })
      .where(eq(botAssignment.assignedBotId, owner.botId));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    const [summary] = await db.select().from(botSummary).where(eq(botSummary.id, summaryId));
    expect(summary?.text).toBe(`A refund. [Redacted] And ${ownerWords}, to recall.`);
    const [checkIn] = await db.select().from(botCheckIn).where(eq(botCheckIn.id, checkInId));
    expect(checkIn?.note).toBe("[Redacted]");
    const [helper] = await db.select().from(botHelper).where(eq(botHelper.id, helperId));
    expect(JSON.stringify(helper)).not.toContain(adaWords);
    const left = await db
      .select({ id: botTrigger.id })
      .from(botTrigger)
      .where(like(botTrigger.text, `%${adaWords}%`));
    expect(left).toEqual([]);
  });
});

describe("an open Approval when a Customer is deleted", () => {
  const command = `echo 12 ${adaWords}`;
  const week = 7 * 24 * 60 * 60 * 1000;

  /** A blocked call of Turn `turnId`, as its wait left it: `state` is how far it got. */
  async function blockedCall(
    owner: Awaited<ReturnType<typeof serving>>,
    turnId: string,
    state: "waiting" | "pending",
  ) {
    const now = owner.timer.clock.now();
    const id = uuidv7();
    await getTestDb()
      .insert(botReview)
      .values({
        id,
        botId: owner.botId,
        turnId,
        toolCallId: `call-${id}`,
        tool: "shell",
        input: { command },
        summary: `Writes to ${adaWords}`,
        verdict: "block",
        reason: `Nobody asked to write to ${adaWords}`,
        state,
        deadline: new Date(now.getTime() + 15_000),
        ...(state === "pending" && { expiresAt: new Date(now.getTime() + week) }),
        createdAt: now,
      });
    return id;
  }

  const reviewOf = async (id: string) =>
    (await getTestDb().select().from(botReview).where(eq(botReview.id, id)))[0]!;

  const firstTurnOf = async (botId: string) =>
    (
      await getTestDb()
        .select()
        .from(botTurn)
        .where(eq(botTurn.botId, botId))
        .orderBy(botTurn.startedAt)
        .limit(1)
    )[0]!;

  const runCommands = (owner: Awaited<ReturnType<typeof serving>>) =>
    owner.computerFake.callsOf("run").map((call) => call.command);

  it.each(["waiting", "pending"] as const)(
    "denies a %s one from a Turn wholly on it, without its call or text, and a yes can't run it",
    async (state) => {
      const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
      await owner.say("I'd like a refund.", adaNumber);
      const turn = await firstTurnOf(owner.botId);
      const id = await blockedCall(owner, turn.id, state);
      const ada = await owner.customerAt(adaNumber);

      await owner.rpc.representative.customerDelete({ id: ada.id });

      const review = await reviewOf(id);
      expect(review.state).toBe("denied");
      expect(review.decidedAt).toEqual(expect.any(Date));
      expect(review.input).toEqual({});
      expect(JSON.stringify(review)).not.toContain(adaWords);
      expect(await owner.rpc.reviews.allow({ reviewId: id })).toMatchObject({
        decided: false,
        state: "denied",
      });
      await owner.drain();
      expect(runCommands(owner)).toEqual([]);
    },
  );

  it("takes back a yes whose call hasn't started", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "pending");
    await owner.rpc.reviews.allow({ reviewId: id });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await owner.drain();

    const review = await reviewOf(id);
    expect(review.state).toBe("denied");
    expect(review.input).toEqual({});
    expect(runCommands(owner)).toEqual([]);
  });

  it("redacts the Trigger a call already run left", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet, quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "pending");
    await owner.rpc.reviews.allow({ reviewId: id });
    await owner.drain();
    expect(runCommands(owner)).toEqual([command]);
    expect(await records([owner.botId])).toContain("[Approval] The user approved");
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await records([owner.botId])).not.toContain(adaWords);
    expect(JSON.stringify(await reviewOf(id))).not.toContain(adaWords);
  });

  const approvedJob = async (id: string) =>
    (
      await getTestDb()
        .select()
        .from(job)
        .where(eq(job.idempotencyKey, `approved-call:${id}`))
    )[0]!;

  it("cancels a retry past its start marker, but doesn't call a call that may have run denied", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "pending");
    await owner.rpc.reviews.allow({ reviewId: id });
    const queued = await approvedJob(id);
    await getTestDb()
      .insert(jobEvent)
      .values({ jobId: queued.id, seq: 1, kind: "activity", name: "call_start" });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await owner.drain();

    const review = await reviewOf(id);
    expect(review.state).toBe("allowed");
    expect(review.input).toEqual({});
    expect((await approvedJob(id)).status).toBe("cancelled");
    expect(runCommands(owner)).toEqual([]);
    expect(await records([owner.botId])).not.toContain("[Approval]");
  });

  it("denies a yes whose job is claimed but hasn't started, so it can't run with its call cleared", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "pending");
    await owner.rpc.reviews.allow({ reviewId: id });
    await getTestDb()
      .update(job)
      .set({ status: "running" })
      .where(eq(job.idempotencyKey, `approved-call:${id}`));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect((await reviewOf(id)).state).toBe("denied");
  });

  it("lets a call running through the delete finish, keeping no result and waking no one", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const owner = await serving({
      turnRounds: [adaHandsOff],
      botRounds: [quiet, quiet],
      onCommand: async () => {
        await released;
        return { exitCode: 0, stdout: `Wrote to ${adaWords}`, stderr: "" };
      },
    });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "pending");
    await owner.rpc.reviews.allow({ reviewId: id });
    const ada = await owner.customerAt(adaNumber);
    const running = owner.drain();
    await vi.waitFor(() => expect(runCommands(owner)).toEqual([command]), { timeout: 10_000 });

    await owner.rpc.representative.customerDelete({ id: ada.id });
    release();
    await running;
    await owner.drain();

    const review = await reviewOf(id);
    expect(review.output).toBeNull();
    expect(JSON.stringify(review)).not.toContain(adaWords);
    expect(await records([owner.botId])).not.toContain("[Approval]");
    expect(await records([owner.botId])).not.toContain(adaWords);
  });

  it("keeps no output a call inside a Turn reports after the delete", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const id = await blockedCall(owner, turn.id, "waiting");
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    await recordReviewOutput(
      owner.deps,
      { turnId: turn.id, conversationId: turn.conversationId },
      `call-${id}`,
      { stdout: `Wrote to ${adaWords}` },
    );

    expect((await reviewOf(id)).output).toBeNull();
  });

  it("redacts the card of a Helper's Approval, which no Turn's time covers", async () => {
    const owner = await serving({ turnRounds: [adaHandsOff], botRounds: [quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    const turn = await firstTurnOf(owner.botId);
    const db = getTestDb();
    owner.timer.advance(60_000);
    const now = owner.timer.clock.now();
    const helperId = crypto.randomUUID();
    await db.insert(botHelper).values({
      id: helperId,
      botId: owner.botId,
      type: "general",
      task: "Look it up.",
      status: "running",
      startedByTurnId: turn.id,
      transcript: [],
      startedAt: now,
    });
    const id = uuidv7();
    const summary = "Posts a note about the caller's parcel.";
    await db.insert(botReview).values({
      id,
      botId: owner.botId,
      helperId,
      toolCallId: `call-${id}`,
      tool: "shell",
      input: { command },
      summary,
      verdict: "block",
      reason: "Nobody asked for it.",
      state: "waiting",
      deadline: new Date(now.getTime() + 15_000),
      createdAt: now,
    });
    const messageId = uuidv7();
    const [own] = await db
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, owner.botId));
    await db.insert(message).values({
      id: messageId,
      conversationId: own!.conversationId,
      role: "assistant",
      authorBotId: owner.botId,
      parts: controlParts(summary, { kind: "review_approval", reviewId: id }),
      status: "complete",
      createdAt: now,
    });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect((await reviewOf(id)).state).toBe("denied");
    const [card] = await db.select().from(message).where(eq(message.id, messageId));
    expect(JSON.stringify(card!.parts)).not.toContain(summary);
    expect(JSON.stringify(card!.parts)).toContain("review_approval");
  });

  it("leaves one from a Turn on other work pending, and it still runs on a yes", async () => {
    const turnRounds: Rounds = [adaHandsOff];
    const owner = await serving({ turnRounds, botRounds: [quiet, quiet, quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    turnRounds.push(carolHandsOff);
    await owner.say("I'd like a refund too.", carolNumber);
    const carolTurnId = (
      await getTestDb()
        .select({ turnId: botTrigger.turnId })
        .from(botTrigger)
        .where(like(botTrigger.text, `%${carolWords}%`))
    )[0]!.turnId!;
    const id = await blockedCall(owner, carolTurnId, "pending");
    const before = await reviewOf(id);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await reviewOf(id)).toEqual(before);
    expect(await owner.rpc.reviews.allow({ reviewId: id })).toMatchObject({ decided: true });
    await owner.drain();
    expect(runCommands(owner)).toEqual([command]);
  });

  it("leaves a mixed Turn's pending, with its stored call, and it still runs on a yes", async () => {
    const turnRounds: Rounds = [adaHandsOff];
    const owner = await serving({ turnRounds, botRounds: [quiet, quiet, quiet] });
    await owner.say("I'd like a refund.", adaNumber);
    turnRounds.push(carolHandsOff);
    await owner.say("I'd like a refund too.", carolNumber);
    const db = getTestDb();
    const turn = await firstTurnOf(owner.botId);
    const carolId = (await assignmentsOf([owner.botId])).find((row) =>
      row.title.includes(carolWords),
    )!.id;
    await db
      .update(botTrigger)
      .set({ turnId: turn.id })
      .where(eq(botTrigger.id, `assignment:${carolId}`));
    const id = await blockedCall(owner, turn.id, "pending");
    const before = await reviewOf(id);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    expect(await reviewOf(id)).toEqual(before);
    const [after] = await db.select().from(botTurn).where(eq(botTurn.id, turn.id));
    expect(JSON.stringify(after!.transcript)).not.toContain(adaWords);
    expect(await owner.rpc.reviews.allow({ reviewId: id })).toMatchObject({ decided: true });
    await owner.drain();
    expect(runCommands(owner)).toEqual([command]);
  });
});

describe("what a Check-in's Turn or a Helper does through the delete", () => {
  const command = `echo 12 ${adaWords}`;
  const hour = 60 * 60 * 1000;

  const redactionPasses = () =>
    getTestDb().select({ id: job.id }).from(job).where(eq(job.name, "bot.assignment_redaction"));

  /** A held Model call, and what lets it go. */
  function holdable(at: number) {
    let open = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    return { holdCall: (call: number) => (call === at ? held : undefined), open };
  }

  /** A pending Approval, asked for now by `source`. */
  async function asksApproval(
    owner: Awaited<ReturnType<typeof serving>>,
    source: { turnId: string } | { helperId: string },
  ) {
    const now = owner.timer.clock.now();
    const id = uuidv7();
    await getTestDb()
      .insert(botReview)
      .values({
        id,
        botId: owner.botId,
        ...source,
        toolCallId: `call-${id}`,
        tool: "shell",
        input: { command },
        summary: `Writes to ${adaWords}`,
        verdict: "block",
        reason: `Nobody asked to write to ${adaWords}`,
        state: "pending",
        deadline: new Date(now.getTime() + 15_000),
        expiresAt: new Date(now.getTime() + 7 * 24 * hour),
        createdAt: now,
      });
    return id;
  }

  const reviewOf = async (id: string) =>
    (await getTestDb().select().from(botReview).where(eq(botReview.id, id)))[0]!;

  const expectDeniedForGood = async (owner: Awaited<ReturnType<typeof serving>>, id: string) => {
    const review = await reviewOf(id);
    expect(review.state).toBe("denied");
    expect(review.input).toEqual({});
    expect(JSON.stringify(review)).not.toContain(adaWords);
    expect(await owner.rpc.reviews.allow({ reviewId: id })).toMatchObject({
      decided: false,
      state: "denied",
    });
    await owner.drain();
    expect(owner.computerFake.callsOf("run").map((call) => call.command)).toEqual([]);
  };

  /** Ada's Turn sets a Check-in an hour ahead; call 3 of the Bot's Model is the Check-in's Turn. */
  async function withCheckIn(holdCall?: (call: number) => Promise<void> | undefined) {
    const made: { at: Date } = { at: new Date(0) };
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        () =>
          round(
            toolCall({
              name: "set_check_in",
              input: { at: made.at.toISOString(), note: `Call 12 ${adaWords} again.` },
            }),
          ),
        quiet,
        says(`Called 12 ${adaWords}.`),
      ],
      holdCall,
    });
    made.at = new Date(owner.timer.clock.now().getTime() + hour);
    await owner.say("I'd like a refund.", adaNumber);
    owner.timer.advance(hour);
    return owner;
  }

  /** Ada's Turn starts a Helper; call 3 of the Bot's Model is the Helper's. */
  async function withHelper(holdCall?: (call: number) => Promise<void> | undefined) {
    const owner = await serving({
      turnRounds: [adaHandsOff, quiet],
      botRounds: [
        () =>
          round(
            toolCall({
              name: "start_helper",
              input: { type: "general", task: `Look up 12 ${adaWords}.` },
            }),
          ),
        quiet,
        () => round(text(`Found 12 ${adaWords}.`)),
      ],
      holdCall,
    });
    // Only as far as the Helper's Model call, which the test then holds.
    await startTestCustomerTurn(owner.deps, {
      representativeId: (await owner.rpc.representative.list())[0]!.id,
      message: "I'd like a refund.",
      externalId: adaNumber,
    });
    return owner;
  }

  const runningTurnOf = async (botId: string) =>
    (
      await getTestDb()
        .select()
        .from(botTurn)
        .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")))
    )[0]!;

  it("denies what a Check-in's Turn asks after the delete, and redacts what it stored", async () => {
    const { holdCall, open } = holdable(3);
    const owner = await withCheckIn(holdCall);
    const attempt = owner.drain();
    await vi.waitFor(() => expect(owner.entered).toHaveLength(3), { timeout: 10_000 });
    const turn = await runningTurnOf(owner.botId);
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    const asked = await asksApproval(owner, { turnId: turn.id });

    open();
    await attempt;
    await owner.drain();
    await expectDeniedForGood(owner, asked);
    expect(await records([owner.botId])).not.toContain(adaWords);
  });

  it("denies what a Helper asks after the delete, and redacts what it stored", async () => {
    const { holdCall, open } = holdable(3);
    const owner = await withHelper(holdCall);
    const attempt = owner.drain();
    await vi.waitFor(() => expect(owner.entered).toHaveLength(3), { timeout: 10_000 });
    const [running] = await getTestDb()
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(eq(botHelper.status, "running"));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    const asked = await asksApproval(owner, { helperId: running!.id });

    open();
    await attempt;
    await owner.drain();
    await expectDeniedForGood(owner, asked);
    const [helper] = await getTestDb()
      .select()
      .from(botHelper)
      .where(eq(botHelper.id, running!.id));
    expect(helper!.status).toBe("complete");
    expect(JSON.stringify(helper)).not.toContain(adaWords);
    expect(await records([owner.botId])).not.toContain(adaWords);
  });

  it("queues the pass at a Helper's own end, before any Turn takes its report", async () => {
    const { holdCall, open } = holdable(3);
    const owner = await withHelper(holdCall);
    const helperEnded = async () =>
      !(await getTestDb().select().from(botHelper).where(eq(botHelper.status, "running"))).length;
    const attempt = (async () => {
      let started = false;
      for (let claimed = await owner.nextJob(); claimed; claimed = await owner.nextJob()) {
        await owner.jobs.runClaimed(claimed, {});
        started ||= owner.entered.length >= 3;
        if (started && (await helperEnded())) return;
      }
    })();
    await vi.waitFor(() => expect(owner.entered).toHaveLength(3), { timeout: 10_000 });
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });

    open();
    await attempt;
    expect(owner.entered).toHaveLength(3);
    expect(await redactionPasses()).not.toEqual([]);
  });

  it("redacts a Helper's hand-off and its card, and denies what it asked, while it waits", async () => {
    const { holdCall, open } = holdable(3);
    const owner = await withHelper(holdCall);
    const attempt = owner.drain();
    await vi.waitFor(() => expect(owner.entered).toHaveLength(3), { timeout: 10_000 });
    const db = getTestDb();
    const [running] = await db
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(eq(botHelper.status, "running"));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    const asked = await asksApproval(owner, { helperId: running!.id });
    await db.transaction((tx) =>
      handOff(
        owner.deps,
        tx,
        { id: running!.id, botId: owner.botId, userId: owner.user.id },
        `Log in to ${adaWords}'s refund account.`,
        { transcript: [{ role: "assistant", content: `Found 12 ${adaWords}.` }], usage: null },
      ),
    );
    open();
    await attempt;
    await owner.drain();

    await expectDeniedForGood(owner, asked);
    const [helper] = await db.select().from(botHelper).where(eq(botHelper.id, running!.id));
    expect(helper!.status).toBe("waiting");
    expect(JSON.stringify(helper)).not.toContain(adaWords);
    expect(await records([owner.botId])).not.toContain(adaWords);
  });

  it("denies what a stopped Helper asked, and redacts what it stored", async () => {
    const { holdCall, open } = holdable(3);
    const owner = await withHelper(holdCall);
    const attempt = owner.drain();
    await vi.waitFor(() => expect(owner.entered).toHaveLength(3), { timeout: 10_000 });
    const [running] = await getTestDb()
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(eq(botHelper.status, "running"));
    const ada = await owner.customerAt(adaNumber);

    await owner.rpc.representative.customerDelete({ id: ada.id });
    const asked = await asksApproval(owner, { helperId: running!.id });

    await stopBotHelpers(owner.deps, owner.botId, running!.id);
    open();
    await attempt;
    await owner.drain();
    await expectDeniedForGood(owner, asked);
    const [helper] = await getTestDb()
      .select()
      .from(botHelper)
      .where(eq(botHelper.id, running!.id));
    expect(helper!.status).toBe("stopped");
    expect(JSON.stringify(helper)).not.toContain(adaWords);
  });

  it("queues no pass for a Check-in's Turn with no delete during it", async () => {
    const owner = await withCheckIn();
    await owner.drain();
    expect(owner.entered).toHaveLength(3);
    expect(await redactionPasses()).toEqual([]);
  });

  it("queues no pass for a Helper with no delete during it", async () => {
    const owner = await withHelper();
    await owner.drain();
    const helpers = await getTestDb()
      .select({ status: botHelper.status })
      .from(botHelper)
      .where(eq(botHelper.botId, owner.botId));
    expect(helpers).toEqual([{ status: "complete" }]);
    expect(await redactionPasses()).toEqual([]);
  });
});

describe("the order a delete takes its locks in", () => {
  /** Whether a Conversation's row is free to lock right now, without waiting for it. */
  const isFree = (id: string) =>
    getTestDb().transaction(async (tx) => {
      const rows = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, id))
        .for("update", { skipLocked: true });
      return rows.length === 1;
    });

  it("waits on the lowest Conversation with the higher still free, then finishes", async () => {
    const owner = await serving({
      turnRounds: [adaHandsOff],
      botRounds: [
        () =>
          round(
            runs("assign_work", {
              bot: "Helper",
              title: `Parcel at ${adaWords}`,
              instructions: `Collect from 12 ${adaWords}.`,
            }),
          ),
        finished(`Collected at ${adaWords}.`),
      ],
    });
    await owner.say("I'd like a refund.", adaNumber);
    const botIds = [owner.botId, owner.helperId];
    const owned = await getTestDb()
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(inArray(bot.id, botIds));
    const [low, high] = owned.map((row) => row.conversationId).sort() as [string, string];
    const ada = await owner.customerAt(adaNumber);

    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holderPid: number | undefined;
    const holding = getTestDb().transaction(async (tx) => {
      await tx.select().from(conversation).where(eq(conversation.id, low)).for("update");
      const pids = await tx.execute(sql`select pg_backend_pid() as pid`);
      holderPid = (pids.rows[0] as { pid: number }).pid;
      await released;
    });
    await vi.waitFor(() => expect(holderPid).toBeDefined(), { timeout: 10_000 });

    const deleting = owner.rpc.representative.customerDelete({ id: ada.id });
    await vi.waitFor(
      async () => {
        const blocked = await getTestDb().execute(
          sql`select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))`,
        );
        expect(blocked.rows.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );

    expect(await isFree(high)).toBe(true);
    release();
    await holding;
    await deleting;
    expect(await records(botIds)).not.toContain(adaWords);
  });
});

describe("the order a hand-off takes its locks in", () => {
  const replyWithNoSource = () =>
    round(
      toolCall({ name: "reply", input: { topic: "general", text: "It's fine.", kind: "answer" } }),
    );

  /** Whether `table`'s row `id` is free to lock right now, without waiting for it. */
  const isFree = (table: typeof conversation | typeof representativeThread, id: string) =>
    getTestDb().transaction(async (tx) => {
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, id))
        .for("update", { skipLocked: true });
      return rows.length === 1;
    });

  /**
   * Plays a Turn with `turnRounds` while its Customer's row is held as a delete or a merge holds it,
   * from its `heldAt`-th Model call, or, with `failing`, as its job fails for good before any such
   * call. Returns what was free while the Turn waited on that row.
   */
  async function whileCustomerHeld(
    turnRounds: Rounds,
    heldAt: number,
    { failing = false }: { failing?: boolean } = {},
  ) {
    let calls = 0;
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding: Promise<void> | undefined;
    let holderPid: number | undefined;
    let owner: Awaited<ReturnType<typeof serving>> | undefined = undefined;
    const hold = async () => {
      calls += 1;
      if (calls !== heldAt) return;
      const ada = await owner!.customerAt(adaNumber);
      let ready = () => {};
      const started = new Promise<void>((resolve) => (ready = resolve));
      holding = getTestDb().transaction(async (tx) => {
        await holdCustomers(tx, [ada.id]);
        const pids = await tx.execute(sql`select pg_backend_pid() as pid`);
        holderPid = (pids.rows[0] as { pid: number }).pid;
        ready();
        await released;
      });
      await started;
    };
    owner = await serving({ turnRounds, botRounds: [], onTurnCall: hold });
    if (failing) {
      const { representativeLoop } = owner.context();
      vi.spyOn(representativeLoop!, "run").mockImplementation(async () => {
        await hold();
        throw new PermanentJobError("The database went away");
      });
    }
    const saying = owner.say("I'd like a refund.", adaNumber);
    try {
      await vi.waitFor(
        async () => {
          expect(holderPid).toBeDefined();
          const blocked = await getTestDb().execute(
            sql`select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))`,
          );
          expect(blocked.rows.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      const [row] = await getTestDb()
        .select({ conversationId: bot.conversationId })
        .from(bot)
        .where(eq(bot.id, owner.botId));
      const [thread] = await getTestDb().select().from(representativeThread);
      return {
        conversationFree: await isFree(conversation, row!.conversationId),
        threadFree: await isFree(representativeThread, thread!.id),
      };
    } finally {
      release();
      await holding;
      await saying;
    }
  }

  it("a Turn's hand_to_bot waits on the Customer before taking the Conversation", async () => {
    const free = await whileCustomerHeld([adaHandsOff], 1);

    expect(free).toEqual({ conversationFree: true, threadFree: true });
  });

  it("code's hand-off waits on the Customer before taking the thread or the Conversation", async () => {
    const free = await whileCustomerHeld([replyWithNoSource, replyWithNoSource], 2);

    expect(free).toEqual({ conversationFree: true, threadFree: true });
  });

  it("the hand-off at a quiet Turn's end waits on the Customer before taking the thread", async () => {
    const free = await whileCustomerHeld([quiet], 1);

    expect(free).toEqual({ conversationFree: true, threadFree: true });
  });

  it("a failed job's hand-off waits on the Customer before taking the thread", async () => {
    const free = await whileCustomerHeld([quiet], 1, { failing: true });

    expect(free).toEqual({ conversationFree: true, threadFree: true });
  });
});
