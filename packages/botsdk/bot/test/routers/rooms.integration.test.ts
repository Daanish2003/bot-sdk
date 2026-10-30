import type { TextOptions } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { appendMessage } from "../../src/chat/message-tree";
import { createBot, textParts } from "../../src/bot/conversation/store";
import { bot, botTrigger, botTurn, message } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, type FakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A SendToUser call that ends the Turn. */
const says = (text: string) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn: true } }));

/**
 * A user with an OpenAI key and three Bots (Scout, Writer, Ops), whose Turns play `rounds`, or call
 * `adapter` when given.
 */
async function threeBots(rounds: Round[] = [], adapter?: FakeAdapter["adapter"]) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({ jobs, adapterFor: () => adapter ?? fake.adapter });
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
  return { fake, deps, jobs, user, client, scout, writer, ops };
}

/** The text of each system prompt a call sent. */
const systemOf = (call: TextOptions) =>
  (call.systemPrompts ?? []).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

/** The text of each user-role message a call sent, after its first (the Prompt start's). */
const userTextsOf = (call: TextOptions) =>
  call.messages
    .slice(1)
    .filter((entry) => entry.role === "user")
    .map((entry) => (typeof entry.content === "string" ? entry.content : JSON.stringify(entry)));

const turnsOf = (botId: string) =>
  getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));

describe("rooms", () => {
  it(
    "creates a Room with two or more of the user's Bots, the first the lead, and lists and gets it",
    async () => {
      const { client, scout, writer, ops } = await threeBots();
      const room = await client.rooms.create({
        name: " Launch ",
        botIds: [writer.id, scout.id, ops.id],
      });
      expect(room).toMatchObject({
        name: "Launch",
        members: [
          { botId: writer.id, name: "Writer", lead: true },
          { botId: scout.id, name: "Scout", lead: false },
          { botId: ops.id, name: "Ops", lead: false },
        ],
      });
      expect(await client.rooms.list()).toEqual([room]);
      const got = await client.rooms.get({ conversationId: room.conversationId });
      expect(got).toMatchObject({ room, messages: [], lastSeq: 0 });
      // The Bots' own Conversations stay as they were.
      expect((await client.bots.list()).map((listed) => listed.name).sort()).toEqual([
        "Ops",
        "Scout",
        "Writer",
      ]);
    },
    timeout,
  );

  it(
    "refuses a Room with fewer than two Bots, or with another user's Bot",
    async () => {
      const { deps, client, scout, writer } = await threeBots();
      await expect(client.rooms.create({ name: "Solo", botIds: [scout.id] })).rejects.toMatchObject(
        { data: { code: "error.roomTooFewBots" } },
      );
      await expect(
        client.rooms.create({ name: "Twice", botIds: [scout.id, scout.id] }),
      ).rejects.toMatchObject({ data: { code: "error.roomTooFewBots" } });
      const other = await insertUser();
      const stranger = chatRpc({ user: other, deps });
      const theirs = await createBot(getTestDb(), other.id, { name: "Theirs", model }, new Date());
      await expect(
        client.rooms.create({ name: "Mixed", botIds: [scout.id, theirs.id] }),
      ).rejects.toMatchObject({ data: { code: "error.botNotFound" } });
      expect(await client.rooms.list()).toEqual([]);
      // Nor can another user read or send to the user's Room.
      const room = await client.rooms.create({ name: "Mine", botIds: [scout.id, writer.id] });
      await expect(
        stranger.rooms.get({ conversationId: room.conversationId }),
      ).rejects.toMatchObject({ data: { code: "error.roomNotFound" } });
      await expect(
        stranger.rooms.send({ conversationId: room.conversationId, text: "hi" }),
      ).rejects.toMatchObject({ data: { code: "error.roomNotFound" } });
      await expect(
        stranger.conversations.changes({ conversationId: room.conversationId, since: 0 }),
      ).rejects.toMatchObject({ data: { code: "error.conversationNotFound" } });
      // A Bot's 1:1 Conversation is not a Room.
      const thread = await client.bots.get({ botId: scout.id });
      await expect(
        client.rooms.get({ conversationId: thread.conversationId }),
      ).rejects.toMatchObject({ data: { code: "error.roomNotFound" } });
    },
    timeout,
  );

  it(
    "runs a Turn for the lead only on a user Message, and its reply lands in the Room as the lead's",
    async () => {
      const { fake, client, scout, writer } = await threeBots([says("On it.")]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      const sent = await client.rooms.send({
        conversationId: room.conversationId,
        text: "Find me three venues.",
      });
      expect(sent).toMatchObject({ role: "user", text: "Find me three venues." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);
      expect(await turnsOf(writer.id)).toEqual([]);
      expect(fake.calls.filter(isTurnCall)).toHaveLength(1);
      const { messages } = await client.rooms.get({ conversationId: room.conversationId });
      expect(messages.map(({ role, text, authorBotId }) => ({ role, text, authorBotId }))).toEqual([
        { role: "user", text: "Find me three venues.", authorBotId: undefined },
        { role: "assistant", text: "On it.", authorBotId: scout.id },
      ]);
      // The thread follows through the Conversation change log, as a 1:1 thread does.
      const changes = await client.conversations.changes({
        conversationId: room.conversationId,
        since: 0,
      });
      if (changes.reload) throw new Error("The change log asked for a reload");
      const sentData = changes.changes.flatMap((change) =>
        change.kind === "message" && change.data ? [change.data] : [],
      );
      expect(sentData.at(-1)).toMatchObject({ text: "On it.", authorBotId: scout.id });
      // Neither Bot's 1:1 Conversation got anything.
      for (const botId of [scout.id, writer.id]) {
        expect((await client.bots.get({ botId })).messages).toEqual([]);
      }
    },
    timeout,
  );

  it(
    "hints the Room on a user Message, so other tabs fetch the change",
    async () => {
      const { deps, jobs, client, scout, writer } = await threeBots();
      // No Turn runs, so the only hint is the send's.
      await jobs.stop();
      started.splice(started.indexOf(jobs), 1);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      const events: string[] = [];
      await deps.pubsub.subscribe(conversationChannel(room.conversationId), (hint) => {
        events.push(hint);
      });

      await client.rooms.send({ conversationId: room.conversationId, text: "Anyone there?" });

      await expect.poll(() => events, poll).toEqual([JSON.stringify({ type: "changed" })]);
    },
    timeout,
  );

  it(
    "keeps the user's time zone on a Room Message, from the newest one they sent",
    async () => {
      const { jobs, client, scout, writer } = await threeBots();
      await jobs.stop();
      started.splice(started.indexOf(jobs), 1);
      await client.bots.send({
        botId: writer.id,
        id: uuidv7(),
        text: "Hi",
        timeZone: "Asia/Kolkata",
      });
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });

      const sent = await client.rooms.send({ conversationId: room.conversationId, text: "Hello" });

      const [row] = await getTestDb()
        .select({ parts: message.parts })
        .from(message)
        .where(eq(message.id, sent.id));
      expect(row!.parts.timeZone).toBe("Asia/Kolkata");
    },
    timeout,
  );

  it(
    "routes to the earliest remaining member once the lead Bot is deleted",
    async () => {
      const { client, scout, writer, ops } = await threeBots([says("Here.")]);
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });
      await getTestDb().delete(bot).where(eq(bot.id, scout.id));

      await client.rooms.send({ conversationId: room.conversationId, text: "Anyone?" });

      await expect
        .poll(async () => (await turnsOf(writer.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);
      expect(await turnsOf(ops.id)).toEqual([]);
    },
    timeout,
  );

  it(
    "gives a Room Turn the others' Messages labelled by author, marks what woke it, and leaves out its own",
    async () => {
      const { fake, client, scout, writer, ops } = await threeBots([says("Looks good.")]);
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });
      const db = getTestDb();
      const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
      await db.transaction(async (tx) => {
        await appendMessage(tx, room.conversationId, {
          role: "user",
          parts: textParts("Draft the launch post."),
          status: "complete",
          createdAt: at(60),
        });
        await appendMessage(tx, room.conversationId, {
          role: "assistant",
          authorBotId: writer.id,
          parts: textParts("Draft is ready."),
          status: "complete",
          createdAt: at(50),
        });
        await appendMessage(tx, room.conversationId, {
          role: "assistant",
          authorBotId: scout.id,
          parts: textParts("A note Scout wrote itself."),
          status: "complete",
          createdAt: at(40),
        });
      });
      await client.rooms.send({ conversationId: room.conversationId, text: "Scout, review it." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);

      const [call] = fake.calls.filter(isTurnCall);
      const inputs = userTextsOf(call!);
      expect(inputs).toHaveLength(3);
      expect(inputs[0]).toBe("[User]: Draft the launch post.");
      expect(inputs[1]).toBe("[Writer]: Draft is ready.");
      expect(inputs[2]).toMatch(/\[User\]: \(to you\) Scout, review it\.$/);
      expect(inputs.join("\n")).not.toContain("A note Scout wrote itself.");

      const room_ = systemOf(call!).find((prompt) => prompt.includes('"Launch"'));
      expect(room_).toBeDefined();
      for (const part of ["Scout (lead)", "Writer", "Ops", "You are Scout", "@Name"]) {
        expect(room_).toContain(part);
      }
      expect(room_).toMatch(/nothing to add/);
    },
    timeout,
  );

  it(
    "gives a Room Turn after a reset of the Bot only what came after it in the Room",
    async () => {
      const { fake, client, scout, writer } = await threeBots([says("First."), says("Second.")]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      await client.rooms.send({ conversationId: room.conversationId, text: "Before the reset." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);
      await client.bots.reset({ botId: scout.id, name: "Scout" });
      // Only what is stamped after the reset's millisecond counts as after it.
      await new Promise((resolve) => setTimeout(resolve, 5));

      await client.rooms.send({ conversationId: room.conversationId, text: "After it." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete", "complete"]);

      const [, second] = fake.calls.filter(isTurnCall);
      const sentText = JSON.stringify(second!.messages);
      expect(sentText).not.toContain("Before the reset.");
      expect(sentText).toContain("After it.");
    },
    timeout,
  );

  it(
    "keeps a Bot's 1:1 Conversation as it was: its Turn sees no Room and no Room Message",
    async () => {
      const { fake, client, scout, writer } = await threeBots([
        says("Room reply."),
        says("Direct reply."),
      ]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      await client.rooms.send({ conversationId: room.conversationId, text: "In the Room." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);
      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Just us." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete", "complete"]);

      const [, direct] = fake.calls.filter(isTurnCall);
      expect(systemOf(direct!).join("\n")).not.toContain('"Launch"');
      const sentText = JSON.stringify(direct!.messages);
      expect(sentText).toContain("Just us.");
      expect(sentText).not.toContain("In the Room.");
      expect(sentText).not.toContain("Room reply.");
      const thread = await client.bots.get({ botId: scout.id });
      expect(thread.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Just us." },
        { role: "assistant", text: "Direct reply." },
      ]);
      const rows = await getTestDb()
        .select({ text: message.parts })
        .from(message)
        .where(and(eq(message.conversationId, room.conversationId), eq(message.role, "assistant")));
      expect(rows).toHaveLength(1);
    },
    timeout,
  );
});

/**
 * `fake`'s adapter held at the door: each call is noted in `entered` and waits until `open()`, or
 * until its Turn is stopped, so a test sees which Turns call the Model at the same time.
 */
function held(fake: FakeAdapter) {
  const entered: TextOptions[] = [];
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const adapter: typeof fake.adapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      const signal = options.request?.signal ?? undefined;
      await Promise.race([
        opened,
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
      ]);
      if (signal?.aborted) return;
      yield* fake.adapter.chatStream(options);
    },
  };
  return { adapter, entered, open };
}

/** Who made each Turn call in `calls`: the Bot its Room section names, or "1:1" outside a Room. */
const callersOf = (calls: TextOptions[]) =>
  calls
    .filter(isTurnCall)
    .map((call) => {
      const room = systemOf(call).find((prompt) => prompt.startsWith("[Room]"));
      return room ? (/\. You are ([^.]+)\./.exec(room)?.[1] ?? "?") : "1:1";
    })
    .sort();

const statusesOf = async (botId: string) => (await turnsOf(botId)).map((turn) => turn.status);

describe("mentions in a Room", () => {
  it(
    "runs a Turn for each mentioned Bot, and one for the lead when none is mentioned",
    async () => {
      const { fake, client, scout, writer, ops } = await threeBots(
        Array.from({ length: 3 }, () => says("Done.")),
      );
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });

      await client.rooms.send({
        conversationId: room.conversationId,
        text: "@writer and @Ops, draft and file it.",
      });
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(ops.id), poll).toEqual(["complete"]);
      expect(await turnsOf(scout.id)).toEqual([]);

      await client.rooms.send({ conversationId: room.conversationId, text: "Thanks all." });
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      expect(fake.calls.filter(isTurnCall)).toHaveLength(3);
      // Each mentioned Bot's input marks the Message "(to you)"; the others see it plain.
      const third = fake.calls.filter(isTurnCall).at(-1)!;
      expect(userTextsOf(third).join("\n")).toContain("[User]: @writer and @Ops");
    },
    timeout,
  );

  it(
    "resolves names with spaces, and routes an unmatched @ to the lead",
    async () => {
      const { client, scout, writer } = await threeBots([says("Here."), says("Lead here.")]);
      const team = await client.bots.create({ name: "Ops Team", model });
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, team.id],
      });

      await client.rooms.send({ conversationId: room.conversationId, text: "@ops team, file it" });
      await expect.poll(() => statusesOf(team.id), poll).toEqual(["complete"]);

      await client.rooms.send({
        conversationId: room.conversationId,
        text: "Mail bob@writer.com, cc @Nobody",
      });
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      expect(await turnsOf(writer.id)).toEqual([]);
    },
    timeout,
  );

  it(
    "skips a mentioned paused Bot's Trigger as paused, and doesn't wake the lead in its place",
    async () => {
      const { client, scout, writer } = await threeBots([says("Here.")]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      await client.bots.pause({ botId: writer.id });

      const sent = await client.rooms.send({
        conversationId: room.conversationId,
        text: "@Writer, draft it.",
      });

      const [trigger] = await getTestDb()
        .select()
        .from(botTrigger)
        .where(eq(botTrigger.id, sent.id));
      expect(trigger).toMatchObject({ botId: writer.id, skipReason: "paused" });
      // Give a wrongly woken lead the time to start.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await turnsOf(scout.id)).toEqual([]);
      expect(await turnsOf(writer.id)).toEqual([]);
    },
    timeout,
  );

  it(
    "runs two Bots' Room Turns at the same time",
    async () => {
      const fake = createFakeAdapter({ rounds: [says("One."), says("Two.")] });
      const gate = held(fake);
      const { client, scout, writer } = await threeBots([], gate.adapter);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });

      await client.rooms.send({ conversationId: room.conversationId, text: "@Scout @Writer go" });

      await expect.poll(() => callersOf(gate.entered), poll).toEqual(["Scout", "Writer"]);
      gate.open();
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "runs a Bot's Room Turn while its 1:1 Turn runs",
    async () => {
      const fake = createFakeAdapter({ rounds: [says("One."), says("Two.")] });
      const gate = held(fake);
      const { client, scout, writer } = await threeBots([], gate.adapter);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });

      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Just us." });
      await expect.poll(() => callersOf(gate.entered), poll).toEqual(["1:1"]);
      await client.rooms.send({ conversationId: room.conversationId, text: "@Scout go" });

      await expect.poll(() => callersOf(gate.entered), poll).toEqual(["1:1", "Scout"]);
      gate.open();
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete", "complete"]);
    },
    timeout,
  );

  it(
    "interrupts only the running Turns of the Bots a user Message goes to",
    async () => {
      const fake = createFakeAdapter({
        rounds: Array.from({ length: 4 }, () => says("Ok.")),
      });
      const gate = held(fake);
      const { client, scout, writer } = await threeBots([], gate.adapter);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      await client.rooms.send({ conversationId: room.conversationId, text: "@Scout @Writer go" });
      await expect.poll(() => callersOf(gate.entered), poll).toEqual(["Scout", "Writer"]);

      await client.rooms.send({ conversationId: room.conversationId, text: "@Scout, stop that." });

      await expect.poll(() => statusesOf(scout.id), poll).toContain("stopped");
      expect(await statusesOf(writer.id)).toEqual(["running"]);
      gate.open();
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      await expect
        .poll(async () => (await statusesOf(scout.id)).sort(), poll)
        .toEqual(["complete", "stopped"]);
    },
    timeout,
  );

  it(
    "gives each member its status in the Room: working while it runs a Turn there, paused while paused",
    async () => {
      const fake = createFakeAdapter({ rounds: [says("Ok.")] });
      const gate = held(fake);
      const { client, scout, writer, ops } = await threeBots([], gate.adapter);
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });
      await client.bots.pause({ botId: ops.id });
      await client.rooms.send({ conversationId: room.conversationId, text: "@Writer go" });
      await expect.poll(() => callersOf(gate.entered), poll).toEqual(["Writer"]);

      const statuses = async () =>
        (await client.rooms.get({ conversationId: room.conversationId })).room.members.map(
          (member) => [member.name, member.status],
        );
      expect(await statuses()).toEqual([
        ["Scout", null],
        ["Writer", "working"],
        ["Ops", "paused"],
      ]);
      gate.open();
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      expect(await statuses()).toEqual([
        ["Scout", null],
        ["Writer", null],
        ["Ops", "paused"],
      ]);
      // The Turn's start and end are the Room's changes, so its tabs follow the status; its end
      // hints the Bot's thread too (its Tasks view), which shows only its 1:1's Turn status.
      const turnChanges = async (conversationId: string) => {
        const read = await client.conversations.changes({ conversationId, since: 0 });
        if (read.reload) throw new Error("The change log asked for a reload");
        return read.changes.flatMap((change) =>
          change.kind === "turn" ? [change.data?.status ?? null] : [],
        );
      };
      expect(await turnChanges(room.conversationId)).toContain("complete");
      const { conversationId: direct } = await client.bots.get({ botId: writer.id });
      expect(await turnChanges(direct)).toEqual([null]);
    },
    timeout,
  );
});
