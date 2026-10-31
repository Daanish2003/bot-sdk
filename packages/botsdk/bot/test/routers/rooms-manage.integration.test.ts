import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { appendMessage } from "../../src/chat/message-tree";
import { textParts } from "../../src/bot/conversation/store";
import { bot, botRoomMember, botTrigger, botTurn, conversation, message } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

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

/** A user with an OpenAI key and four Bots (Scout, Writer, Ops, Extra), whose Turns play `rounds`. */
async function fourBots(rounds: Round[] = [], manual = false) {
  const fake = createFakeAdapter({ rounds, manual });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({ jobs, adapterFor: () => fake.adapter });
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
  const extra = await client.bots.create({ name: "Extra", model });
  return { fake, deps, user, client, scout, writer, ops, extra };
}

const turnsOf = (botId: string) =>
  getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));

const membersOf = (conversationId: string) =>
  getTestDb()
    .select({ botId: botRoomMember.botId, lead: botRoomMember.lead })
    .from(botRoomMember)
    .where(eq(botRoomMember.conversationId, conversationId));

describe("managing a Room", () => {
  it(
    "refuses every management call on a Room that belongs to another user",
    async () => {
      const { deps, client, scout, writer, ops } = await fourBots();
      const room = await client.rooms.create({ name: "Mine", botIds: [scout.id, writer.id] });
      const stranger = chatRpc({ user: await insertUser(), deps });
      const conversationId = room.conversationId;

      const calls = [
        () => stranger.rooms.rename({ conversationId, name: "Theirs" }),
        () => stranger.rooms.addMember({ conversationId, botId: ops.id }),
        () => stranger.rooms.removeMember({ conversationId, botId: writer.id }),
        () => stranger.rooms.setLead({ conversationId, botId: writer.id }),
        () => stranger.rooms.delete({ conversationId }),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({ data: { code: "error.roomNotFound" } });
      }
      expect(await client.rooms.get({ conversationId })).toMatchObject({
        room: { name: "Mine" },
      });
    },
    timeout,
  );

  it(
    "renames a Room and changes its lead, and only the user changes the lead",
    async () => {
      const { client, scout, writer, ops } = await fourBots();
      const room = await client.rooms.create({ name: "Old", botIds: [scout.id, writer.id] });

      await client.rooms.rename({ conversationId: room.conversationId, name: " New " });
      await client.rooms.setLead({ conversationId: room.conversationId, botId: writer.id });

      const [renamed] = await client.rooms.list();
      expect(renamed).toMatchObject({
        name: "New",
        members: [
          { botId: scout.id, lead: false },
          { botId: writer.id, lead: true },
        ],
      });
      await expect(
        client.rooms.setLead({ conversationId: room.conversationId, botId: ops.id }),
      ).rejects.toMatchObject({ data: { code: "error.botNotFound" } });
      // The rename shows in the Room's change log, so other tabs refresh.
      const changes = await client.conversations.changes({
        conversationId: room.conversationId,
        since: 0,
      });
      if (changes.reload) throw new Error("The change log asked for a reload");
      expect(changes.changes.length).toBeGreaterThan(0);
    },
    timeout,
  );

  it(
    "adds a Bot that sees the Room's history on its first Turn, and refuses a name that clashes",
    async () => {
      const { fake, client, scout, writer, ops, extra } = await fourBots([says("Ready.")]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      await getTestDb().transaction(async (tx) => {
        await appendMessage(tx, room.conversationId, {
          role: "user",
          parts: textParts("Before Ops joined."),
          status: "complete",
          createdAt: new Date(Date.now() - 60_000),
        });
      });

      await client.rooms.addMember({ conversationId: room.conversationId, botId: ops.id });
      const added = (await client.rooms.list())[0]!;
      expect(added.members.map((member) => member.name)).toEqual(["Scout", "Writer", "Ops"]);
      await client.rooms.setLead({ conversationId: room.conversationId, botId: ops.id });
      await client.rooms.send({ conversationId: room.conversationId, text: "Ops, go." });
      await expect
        .poll(async () => (await turnsOf(ops.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);

      const [call] = fake.calls.filter(isTurnCall);
      expect(JSON.stringify(call!.messages)).toContain("Before Ops joined.");

      // Adding a member twice, or a Bot whose name matches one's in any case, is refused.
      await expect(
        client.rooms.addMember({ conversationId: room.conversationId, botId: ops.id }),
      ).rejects.toMatchObject({ data: { code: "error.roomNameClash" } });
      await getTestDb().update(bot).set({ name: "sCoUt" }).where(eq(bot.id, extra.id));
      await expect(
        client.rooms.addMember({ conversationId: room.conversationId, botId: extra.id }),
      ).rejects.toMatchObject({ data: { code: "error.roomNameClash" } });
      expect(await membersOf(room.conversationId)).toHaveLength(3);
    },
    timeout,
  );

  it(
    "refuses a removal that leaves fewer than two, and promotes the earliest remaining member when the lead goes",
    async () => {
      const { client, scout, writer, ops } = await fourBots();
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });
      const conversationId = room.conversationId;

      await client.rooms.removeMember({ conversationId, botId: scout.id });

      const [after] = await client.rooms.list();
      expect(after!.members).toMatchObject([
        { botId: writer.id, lead: true },
        { botId: ops.id, lead: false },
      ]);
      await expect(
        client.rooms.removeMember({ conversationId, botId: ops.id }),
      ).rejects.toMatchObject({ data: { code: "error.roomTooFewBots" } });
      await expect(
        client.rooms.removeMember({ conversationId, botId: scout.id }),
      ).rejects.toMatchObject({ data: { code: "error.botNotFound" } });
      expect(await membersOf(conversationId)).toHaveLength(2);
    },
    timeout,
  );

  it(
    "cancels the removed Bot's running Turn in the Room and skips its waiting Triggers there",
    async () => {
      const { fake, client, scout, writer, ops } = await fourBots([says("Slow.")], true);
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [scout.id, writer.id, ops.id],
      });
      const conversationId = room.conversationId;
      await client.rooms.send({ conversationId, text: "Start." });
      await expect.poll(() => fake.calls.filter(isTurnCall).length, poll).toBe(1);
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["running"]);
      await getTestDb().insert(botTrigger).values({
        id: "waiting-1",
        botId: scout.id,
        conversationId,
        source: "user",
        channel: "web",
        text: "later",
        receivedAt: new Date(),
      });

      await client.rooms.removeMember({ conversationId, botId: scout.id });

      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["stopped"]);
      const [trigger] = await getTestDb()
        .select()
        .from(botTrigger)
        .where(and(eq(botTrigger.id, "waiting-1"), eq(botTrigger.botId, scout.id)));
      expect(trigger).toMatchObject({ turnId: null, skipReason: "cancelled" });
      expect(trigger!.skippedAt).not.toBeNull();
      expect(await membersOf(conversationId)).toHaveLength(2);
      await fake.releaseAll();
    },
    timeout,
  );

  it(
    "leaves a one-Bot Room when a Bot is deleted: only adding a Bot or deleting the Room is allowed",
    async () => {
      const { client, scout, writer, ops } = await fourBots();
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      const conversationId = room.conversationId;
      await getTestDb().transaction(async (tx) => {
        await appendMessage(tx, conversationId, {
          role: "assistant",
          authorBotId: scout.id,
          parts: textParts("Old words."),
          status: "complete",
          createdAt: new Date(Date.now() - 60_000),
        });
      });

      // Deleting a Bot is never refused; its member row goes with it, its Messages stay.
      await getTestDb().delete(bot).where(eq(bot.id, scout.id));

      const refused = { data: { code: "error.roomOneBot" } };
      await expect(client.rooms.send({ conversationId, text: "Hi" })).rejects.toMatchObject(
        refused,
      );
      await expect(client.rooms.rename({ conversationId, name: "X" })).rejects.toMatchObject(
        refused,
      );
      await expect(
        client.rooms.setLead({ conversationId, botId: writer.id }),
      ).rejects.toMatchObject(refused);
      await expect(
        client.rooms.removeMember({ conversationId, botId: writer.id }),
      ).rejects.toMatchObject(refused);
      const { messages } = await client.rooms.get({ conversationId });
      expect(messages.map((shown) => shown.text)).toEqual(["Old words."]);

      // Adding a Bot makes it a Room again, and the lead the Room lost is the earliest member.
      await client.rooms.addMember({ conversationId, botId: ops.id });
      expect(await membersOf(conversationId)).toHaveLength(2);
      expect((await membersOf(conversationId)).filter((member) => member.lead)).toEqual([
        { botId: writer.id, lead: true },
      ]);
      await client.rooms.rename({ conversationId, name: "Back" });
    },
    timeout,
  );

  it(
    "deletes a Room with its Messages, and the Bots stay with their own Conversations",
    async () => {
      const { client, scout, writer } = await fourBots([says("Direct."), says("Done.")]);
      const room = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
      const conversationId = room.conversationId;
      await client.bots.send({ botId: writer.id, id: uuidv7(), text: "Just us." });
      await client.rooms.send({ conversationId, text: "In the Room." });
      await expect
        .poll(async () => (await turnsOf(scout.id)).map((turn) => turn.status), poll)
        .toEqual(["complete"]);

      await client.rooms.delete({ conversationId });

      expect(await client.rooms.list()).toEqual([]);
      const db = getTestDb();
      expect(
        await db.select().from(conversation).where(eq(conversation.id, conversationId)),
      ).toEqual([]);
      expect(
        await db.select().from(message).where(eq(message.conversationId, conversationId)),
      ).toEqual([]);
      expect((await client.bots.list()).map((listed) => listed.name).sort()).toEqual([
        "Extra",
        "Ops",
        "Scout",
        "Writer",
      ]);
      await expect(client.rooms.delete({ conversationId })).rejects.toMatchObject({
        data: { code: "error.roomNotFound" },
      });
    },
    timeout,
  );
});
