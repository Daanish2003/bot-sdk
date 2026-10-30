import type { TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botTrigger, botTurn } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, type FakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

/*
 * Bot-to-Bot handoffs in a Room (spec #1055): a Bot that mentions another member wakes it with an
 * `agent` Trigger, one hop further down the chain, and the chain stops after three hops until the
 * user speaks.
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

/** A SendToUser call that ends the Turn. */
const says = (text: string) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn: true } }));

/**
 * A user with an OpenAI key and a Room of three Bots (Scout, the lead, Writer and Ops), whose Turns
 * play `rounds`, or call `adapter` when given.
 */
async function threeBotRoom(rounds: Round[] = [], adapter?: FakeAdapter["adapter"]) {
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
  const room = await client.rooms.create({
    name: "Launch",
    botIds: [scout.id, writer.id, ops.id],
  });
  const send = (text: string) => client.rooms.send({ conversationId: room.conversationId, text });
  return { fake, client, scout, writer, ops, room, send };
}

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt));

const statusesOf = async (botId: string) => (await turnsOf(botId)).map((turn) => turn.status);

/** Bot `botId`'s Triggers, oldest first. */
const triggersOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.botId, botId))
    .orderBy(asc(botTrigger.receivedAt));

/** The text of each user-role message a call sent, after its first (the Prompt start's). */
const userTextsOf = (call: TextOptions) =>
  call.messages
    .slice(1)
    .filter((entry) => entry.role === "user")
    .map((entry) => (typeof entry.content === "string" ? entry.content : JSON.stringify(entry)));

/** The text of each system prompt a call sent. */
const systemOf = (call: TextOptions) =>
  (call.systemPrompts ?? []).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

/** The Bot a Turn call is from, as its Room section names it. */
const callerOf = (call: TextOptions) => {
  const room = systemOf(call).find((prompt) => prompt.startsWith("[Room]"));
  return room ? (/\. You are ([^.]+)\./.exec(room)?.[1] ?? "?") : "1:1";
};

describe("handoffs in a Room", () => {
  it(
    "wakes a Bot another mentions with an agent Trigger one hop on, and the Message shows the handoff",
    async () => {
      const { fake, client, scout, writer, ops, room, send } = await threeBotRoom([
        says("Found it. @Writer, draft the post."),
        says("Drafted."),
      ]);

      await send("@Scout, find the release notes.");
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      expect(await statusesOf(scout.id)).toEqual(["complete"]);
      expect(await turnsOf(ops.id)).toEqual([]);

      const [scoutTrigger] = await triggersOf(scout.id);
      expect(scoutTrigger).toMatchObject({ source: "user", hops: 0 });
      const { messages } = await client.rooms.get({ conversationId: room.conversationId });
      const handedOn = messages.find((sent) => sent.authorBotId === scout.id)!;
      expect(handedOn.handoff).toEqual({ to: [writer.id], hops: 1 });
      expect(await triggersOf(writer.id)).toMatchObject([
        { id: handedOn.id, source: "agent", messageId: handedOn.id, hops: 1, skippedAt: null },
      ]);
      // A Message that mentions no one carries no handoff.
      expect(messages.find((sent) => sent.authorBotId === writer.id)?.handoff).toBeUndefined();
      // The Message that woke Writer is marked "(to you)" in its input.
      const writerCall = fake.calls.filter(isTurnCall).find((call) => callerOf(call) === "Writer")!;
      expect(userTextsOf(writerCall).join("\n")).toMatch(
        "[Scout]: (to you) Found it. @Writer, draft the post.",
      );
      // The change log carries the handoff too.
      const read = await client.conversations.changes({
        conversationId: room.conversationId,
        since: 0,
      });
      if (read.reload) throw new Error("The change log asked for a reload");
      const logged = read.changes.find(
        (change) => change.kind === "message" && change.data?.id === handedOn.id,
      );
      expect(logged?.data).toMatchObject({ handoff: { to: [writer.id], hops: 1 } });
    },
    timeout,
  );

  it(
    "skips the fourth hop as hop_limit, never runs it, and starts a fresh chain when the user speaks",
    async () => {
      const { scout, writer, ops, send } = await threeBotRoom([
        says("@Writer, over to you."), // Scout, from the user: hop 1
        says("@Ops, your turn."), // Writer: hop 2
        says("@Scout, back to you."), // Ops: hop 3
        says("@Writer, again."), // Scout: hop 4, stopped
        says("@Ops, carry on."), // Writer, from the user: hop 1 again
        says("Filed."), // Ops
      ]);

      await send("@Scout, start.");
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete", "complete"]);
      await expect
        .poll(async () => (await triggersOf(writer.id)).map((trigger) => trigger.hops), poll)
        .toEqual([1, 4]);
      const stopped = (await triggersOf(writer.id))[1]!;
      expect(stopped).toMatchObject({ source: "agent", skipReason: "hop_limit", turnId: null });
      expect((await triggersOf(ops.id)).map((trigger) => trigger.hops)).toEqual([2]);
      expect((await triggersOf(scout.id)).map((trigger) => trigger.hops)).toEqual([0, 3]);
      // Give a wrongly woken Writer the time to start.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await statusesOf(writer.id)).toEqual(["complete"]);

      await send("@Writer, carry on.");
      await expect.poll(() => statusesOf(ops.id), poll).toEqual(["complete", "complete"]);
      expect((await triggersOf(writer.id)).map((trigger) => trigger.hops)).toEqual([1, 4, 0]);
      expect((await triggersOf(ops.id)).map((trigger) => trigger.hops)).toEqual([2, 1]);
      // The stopped hop stays skipped after the user spoke.
      expect((await triggersOf(writer.id))[1]).toMatchObject({
        skipReason: "hop_limit",
        turnId: null,
      });
      expect(await statusesOf(writer.id)).toEqual(["complete", "complete"]);
    },
    timeout,
  );

  it(
    "wakes no one for a Bot mentioning itself, or a Bot Message with no mention",
    async () => {
      const { scout, writer, ops, send } = await threeBotRoom([
        says("@Scout here: noted, nothing for the others."),
        says("All done."),
      ]);

      await send("@Scout, note it.");
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      await send("Anything else?");
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete", "complete"]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect((await triggersOf(scout.id)).map((trigger) => trigger.source)).toEqual([
        "user",
        "user",
      ]);
      expect(await triggersOf(writer.id)).toEqual([]);
      expect(await triggersOf(ops.id)).toEqual([]);
    },
    timeout,
  );

  it(
    "keeps an agent Trigger waiting for the target's running Turn instead of interrupting it",
    async () => {
      const fake = createFakeAdapter({
        rounds: [says("@Writer, take this too."), says("First done."), says("Second done.")],
      });
      const gate = heldByBot(fake);
      const { scout, writer, send } = await threeBotRoom([], gate.adapter);

      await send("@Scout @Writer go");
      await expect.poll(() => gate.entered.map(callerOf).sort(), poll).toEqual(["Scout", "Writer"]);
      gate.open("Scout");
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      const [, handedOn] = await triggersOf(writer.id);
      expect(handedOn).toMatchObject({ source: "agent", hops: 1, turnId: null, skippedAt: null });
      expect(await statusesOf(writer.id)).toEqual(["running"]);

      gate.open("Writer");
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
      const [, second] = await turnsOf(writer.id);
      expect((await triggersOf(writer.id))[1]).toMatchObject({ turnId: second!.id });
    },
    timeout,
  );

  it(
    "hands off nothing from a Bot's 1:1 Conversation",
    async () => {
      const { client, scout, writer } = await threeBotRoom([says("@Writer should see this.")]);

      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Hi" });
      await expect.poll(() => statusesOf(scout.id), poll).toEqual(["complete"]);
      const thread = await client.bots.get({ botId: scout.id });
      expect(thread.messages.at(-1)).toMatchObject({ role: "assistant" });
      expect(thread.messages.at(-1)?.handoff).toBeUndefined();
      expect(await triggersOf(writer.id)).toEqual([]);
    },
    timeout,
  );
});

/**
 * `fake`'s adapter with a door per Bot: each call is noted in `entered` and waits until `open(name)`
 * for its Bot, or until its Turn is stopped.
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
