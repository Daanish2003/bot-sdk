import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot, botHelper, botReview, botTrigger, botTurn, message } from "../../src/storage";
import { appendBotMessage, controlParts, textParts } from "../../src/bot/conversation";
import { conversationChannel } from "../../src/chat/conversation-events";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  text,
  toolCall,
} from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { fakeReviewer, type FakeReviewer, verdictRound } from "@botsdk/testing/fake-reviewer";

/*
 * Stop, Approvals and Helpers in a Room (spec #1055): one Stop ends every Turn running in the Room
 * and drops its waiting handoffs, an answer wakes only the Bot that asked, and a Helper reports
 * into the Room that started it.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const says = (text: string) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn: true } }));

/** A user with an OpenAI key and a Room of Scout (the lead), Writer and Ops, over `adapter`. */
async function threeBotRoom(
  rounds: Round[] = [],
  adapter?: FakeAdapter["adapter"],
  reviewer?: FakeReviewer,
) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    concurrency: 6,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    adapterFor: () => adapter ?? fake.adapter,
    // Helpers need the Computer.
    computer: fakeComputerProvider().provider,
    memory: false,
    ...(reviewer && { reviewAdapterFor: () => reviewer.adapter }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const scout = await client.bots.create({ name: "Scout", model });
  const writer = await client.bots.create({ name: "Writer", model });
  const ops = await client.bots.create({ name: "Ops", model });
  const room = await client.rooms.create({
    name: "Launch",
    botIds: [scout.id, writer.id, ops.id],
  });
  const send = (text: string) => client.rooms.send({ conversationId: room.conversationId, text });
  return { fake, deps, user, client, scout, writer, ops, room, send };
}

/** The id of Bot `botId`'s 1:1 Conversation. */
const oneToOneOf = async (botId: string) => {
  const [found] = await getTestDb().select().from(bot).where(eq(bot.id, botId));
  return found!.conversationId;
};

/** Bot `botId`'s Turns in Conversation `conversationId` (or all of them), oldest first. */
const turnsOf = (botId: string, conversationId?: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, botId),
        conversationId ? eq(botTurn.conversationId, conversationId) : undefined,
      ),
    )
    .orderBy(asc(botTurn.startedAt));

const statusesOf = async (botId: string, conversationId?: string) =>
  (await turnsOf(botId, conversationId)).map((turn) => turn.status);

const triggersOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.botId, botId))
    .orderBy(asc(botTrigger.receivedAt));

/** The text of each system prompt a call sent. */
const systemOf = (call: TextOptions) =>
  (call.systemPrompts ?? []).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

/** The Bot a Turn call is from, as its Room section names it; "1:1" for a Turn outside a Room. */
const callerOf = (call: TextOptions) => {
  const room = systemOf(call).find((prompt) => prompt.startsWith("[Room]"));
  return room ? (/\. You are ([^.]+)\./.exec(room)?.[1] ?? "?") : "1:1";
};

/**
 * `fake`'s adapter with a door per caller ("Scout", "1:1"): each call is noted in `entered` and
 * waits until `open(name)`, or until its Turn is stopped.
 */
function heldByBot(fake: FakeAdapter) {
  const entered: TextOptions[] = [];
  const doors = new Map<string, { opened: Promise<void>; open: () => void }>();
  const doorOf = (name: string) => {
    let door = doors.get(name);
    if (!door) {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      doors.set(name, (door = { opened, open }));
    }
    return door;
  };
  const adapter: typeof fake.adapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      const signal = options.request?.signal ?? undefined;
      await Promise.race([
        doorOf(callerOf(options)).opened,
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
      ]);
      if (signal?.aborted) return;
      yield* fake.adapter.chatStream(options);
    },
  };
  return { adapter, entered, open: (name: string) => doorOf(name).open() };
}

describe("Stop in a Room", () => {
  it(
    "ends every running Room Turn and cancels a waiting handoff, while a 1:1 Turn and a Helper go on",
    async () => {
      const fake = createFakeAdapter({ rounds: [says("1:1 done.")] });
      const gate = heldByBot(fake);
      const { client, deps, scout, writer, ops, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;

      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Alone" });
      await expect.poll(() => gate.entered.map(callerOf), poll).toEqual(["1:1"]);
      await client.rooms.send({ conversationId, text: "@Scout @Writer go" });
      await expect
        .poll(() => gate.entered.map(callerOf).sort(), poll)
        .toEqual(["1:1", "Scout", "Writer"]);
      const [roomTurn] = await turnsOf(scout.id, conversationId);
      await getTestDb().insert(botHelper).values({
        id: uuidv7(),
        botId: scout.id,
        type: "general",
        task: "Count.",
        status: "running",
        startedByTurnId: roomTurn!.id,
        startedAt: new Date(),
      });
      await getTestDb().insert(botTrigger).values({
        id: "handoff-1",
        botId: writer.id,
        conversationId,
        source: "agent",
        channel: "room",
        text: "over to you",
        hops: 1,
        receivedAt: new Date(),
      });

      const hints: string[] = [];
      await deps.pubsub.subscribe(conversationChannel(conversationId), (hint) => {
        hints.push(hint);
      });

      await client.rooms.stop({ conversationId });

      await expect.poll(() => hints.length, poll).toBeGreaterThan(0);

      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["stopped"]);
      // Each Turn ends as its own attempt aborts, so one may end a moment after the other.
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["stopped"]);
      expect(await turnsOf(ops.id)).toEqual([]);
      const handoff = (await triggersOf(writer.id)).find((trigger) => trigger.id === "handoff-1");
      expect(handoff).toMatchObject({ turnId: null, skipReason: "cancelled" });
      expect(handoff!.skippedAt).not.toBeNull();
      // Neither the 1:1 Turn nor the Helper was touched.
      expect(await statusesOf(scout.id, await oneToOneOf(scout.id))).toEqual(["running"]);
      const [helper] = await getTestDb().select().from(botHelper);
      expect(helper!.status).toBe("running");
      gate.open("1:1");
      await expect
        .poll(async () => statusesOf(scout.id, await oneToOneOf(scout.id)), poll)
        .toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "refuses another user's Room",
    async () => {
      const { client, room, deps } = await threeBotRoom();
      const other = chatRpc({ user: await insertUser(), deps });
      await expect(other.rooms.stop({ conversationId: room.conversationId })).rejects.toMatchObject(
        {
          data: { code: "error.roomNotFound" },
        },
      );
      await expect(
        client.rooms.stop({ conversationId: room.conversationId }),
      ).resolves.toBeUndefined();
    },
    timeout,
  );
});

describe("Approvals in a Room", () => {
  it(
    "records a Room Approval's changes in the Room, and wakes only the asking Bot on a late no",
    async () => {
      const reviewer = fakeReviewer(() =>
        verdictRound({ outcome: "block", reason: "Not asked.", summary: "Deploy" }),
      );
      const { client, scout, writer, room, send } = await threeBotRoom(
        [
          round(toolCall({ name: "shell", input: { command: "make deploy" } })),
          says("Understood."),
          says("Noted."),
        ],
        undefined,
        reviewer,
      );

      await send("@Writer, deploy it.");
      let waiting: typeof botReview.$inferSelect | undefined;
      await expect
        .poll(async () => {
          [waiting] = await getTestDb()
            .select()
            .from(botReview)
            .where(and(eq(botReview.botId, writer.id), eq(botReview.state, "waiting")));
          return waiting?.id;
        }, poll)
        .toBeDefined();
      // Past its deadline, an answer is a late one: a no wakes the Bot that asked.
      await getTestDb()
        .update(botReview)
        .set({ deadline: new Date(Date.now() - 1_000) })
        .where(eq(botReview.id, waiting!.id));
      await expect(client.reviews.deny({ reviewId: waiting!.id })).resolves.toMatchObject({
        decided: true,
      });

      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
      const approval = (await triggersOf(writer.id)).find(
        (trigger) => trigger.source === "approval",
      );
      expect(approval).toMatchObject({ conversationId: room.conversationId });
      expect(await turnsOf(scout.id)).toEqual([]);
      const inRoom = await client.conversations.changes({
        conversationId: room.conversationId,
        since: 0,
      });
      if (inRoom.reload) throw new Error("expected changes");
      const decided = inRoom.changes.filter(
        (change) => change.kind === "review" && change.refId === waiting!.id,
      );
      expect(decided.length).toBeGreaterThanOrEqual(2);
      expect(decided.at(-1)?.data).toMatchObject({ id: waiting!.id, state: "denied" });
      // Nothing of it is in the Bot's 1:1 log.
      const oneToOne = await client.conversations.changes({
        conversationId: await oneToOneOf(writer.id),
        since: 0,
      });
      if (oneToOne.reload) throw new Error("expected changes");
      expect(oneToOne.changes.filter((change) => change.kind === "review")).toEqual([]);
    },
    timeout,
  );

  it(
    "wakes only the Bot that asked when the user answers a choice in the Room",
    async () => {
      const { client, scout, writer, ops, room, send } = await threeBotRoom([
        round(
          toolCall({
            name: "send_to_user",
            input: {
              text: "Red or blue?",
              endTurn: true,
              choice: { options: ["Red", "Blue"], other: false },
            },
          }),
        ),
        says("Red it is."),
      ]);

      await send("@Writer, which colour?");
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      const { messages } = await client.rooms.get({ conversationId: room.conversationId });
      const asked = messages.findLast((entry) => entry.control?.kind === "choice")!;
      expect(asked.authorBotId).toBe(writer.id);

      // Whichever member the app names, the Message's author is woken.
      await client.bots.choose({ botId: ops.id, messageId: asked.id, answer: { option: "Red" } });

      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
      const answer = (await triggersOf(writer.id)).find((trigger) =>
        trigger.id.startsWith("action:"),
      );
      expect(answer).toMatchObject({ conversationId: room.conversationId, source: "user" });
      expect(await turnsOf(scout.id)).toEqual([]);
      expect(await turnsOf(ops.id)).toEqual([]);
      const after = await client.rooms.get({ conversationId: room.conversationId });
      expect(after.messages.find((entry) => entry.id === asked.id)?.control).toMatchObject({
        answer: { text: "Red" },
      });
      // The 1:1 Conversation has no such Message.
      expect((await client.bots.get({ botId: writer.id })).messages).toEqual([]);
    },
    timeout,
  );
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  systemOf(options).some((prompt) => prompt.startsWith("You are a Helper"));

describe("Helpers in a Room", () => {
  it(
    "reports into the Bot's 1:1 Conversation once the Bot has left the Room",
    async () => {
      const turns = createFakeAdapter({
        rounds: [
          round(toolCall({ name: "start_helper", input: { type: "general", task: "Count." } })),
          says("On it."),
          says("The count is 3."),
        ],
      });
      const helpers = createFakeAdapter({ rounds: [round(text("Counted 3."))], manual: true });
      const adapter = {
        ...turns.adapter,
        chatStream: (options: TextOptions) =>
          isHelperCall(options)
            ? helpers.adapter.chatStream(options)
            : turns.adapter.chatStream(options),
      } as AnyTextAdapter;
      const { client, writer, room, send } = await threeBotRoom([], adapter);

      await send("@Writer, count the files.");
      await expect.poll(() => helpers.calls.length, poll).toBe(1);
      await expect
        .poll(() => statusesOf(writer.id, room.conversationId), poll)
        .toEqual(["complete"]);
      await client.rooms.removeMember({ conversationId: room.conversationId, botId: writer.id });
      await helpers.releaseAll();

      const oneToOne = await oneToOneOf(writer.id);
      await expect.poll(() => statusesOf(writer.id, oneToOne), poll).toEqual(["complete"]);
      const report = (await triggersOf(writer.id)).find((trigger) => trigger.source === "helper");
      expect(report).toMatchObject({ conversationId: oneToOne });
      expect(await statusesOf(writer.id, room.conversationId)).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "reports into the Room that started the Helper, not the Bot's 1:1 Conversation",
    async () => {
      const turns = createFakeAdapter({
        rounds: [
          round(toolCall({ name: "start_helper", input: { type: "general", task: "Count." } })),
          says("On it."),
          says("The count is 3."),
        ],
      });
      const helpers = createFakeAdapter({ rounds: [round(text("Counted 3."))] });
      const adapter = {
        ...turns.adapter,
        chatStream: (options: TextOptions) =>
          isHelperCall(options)
            ? helpers.adapter.chatStream(options)
            : turns.adapter.chatStream(options),
      } as AnyTextAdapter;
      const { client, scout, writer, room, send } = await threeBotRoom([], adapter);

      await send("@Writer, count the files.");

      await expect
        .poll(() => statusesOf(writer.id, room.conversationId), poll)
        .toEqual(["complete", "complete"]);
      const report = (await triggersOf(writer.id)).find((trigger) => trigger.source === "helper");
      expect(report).toMatchObject({ conversationId: room.conversationId });
      expect(report?.text).toContain("Counted 3.");
      const { messages } = await client.rooms.get({ conversationId: room.conversationId });
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        authorBotId: writer.id,
        text: "The count is 3.",
      });
      expect(await statusesOf(writer.id, await oneToOneOf(writer.id))).toEqual([]);
      expect(await turnsOf(scout.id)).toEqual([]);
    },
    timeout,
  );
});

// Kept in the imports for the sections below.
void bot;
void message;
void appendBotMessage;
void controlParts;
void textParts;
