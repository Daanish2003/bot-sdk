import { eq, inArray, like, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import {
  bot,
  botAssignment,
  botAssignmentLog,
  botCheckIn,
  botHelper,
  botSummary,
  botTrigger,
  botTurn,
  conversation,
  job,
  message,
} from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { startTestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { representative } from "../src";
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
}: {
  turnRounds: Rounds;
  botRounds: Rounds;
  held?: Promise<void>;
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
      yield* botFake.adapter.chatStream(options);
    },
  };
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
    jobs,
    clock: timer.clock.now,
    features: [representative()],
    adapterFor: (id) => (id === botModel ? gated : repFake.adapter),
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
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const helper = await rpc.bots.create({ name: "Helper", model: botModel });
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "hand_to_bot"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const nextJob = async () => {
    timer.advance(batchLongestMs);
    return claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
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
