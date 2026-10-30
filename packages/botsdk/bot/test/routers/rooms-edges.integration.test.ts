import type { TextOptions } from "@tanstack/ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot, botTrigger, botTurn, conversation, message } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, type FakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

/*
 * Edges of Rooms found in the branch review of spec #1055: a retried send, a Ban, a per-Bot Stop,
 * the away Summary, and the data export.
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
async function threeBotRoom(rounds: Round[] = [], adapter?: FakeAdapter["adapter"]) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    concurrency: 6,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({ jobs, adapterFor: () => adapter ?? fake.adapter, memory: false });
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
  return { fake, deps, user, client, scout, writer, ops, room };
}

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

/** The id of Bot `botId`'s 1:1 Conversation. */
const oneToOneOf = async (botId: string) => {
  const [found] = await getTestDb().select().from(bot).where(eq(bot.id, botId));
  return found!.conversationId;
};

describe("a retried Room send", () => {
  it(
    "saves one Message and wakes the Bot once, keeping the time zone it was sent from",
    async () => {
      const { client, scout, room } = await threeBotRoom([says("On it.")]);
      const conversationId = room.conversationId;
      const id = uuidv7();
      const sent = { conversationId, id, text: "Plan the launch", timeZone: "Asia/Kolkata" };

      const first = await client.rooms.send(sent);
      const again = await client.rooms.send(sent);

      expect(again).toEqual(first);
      expect(first.id).toBe(id);
      const saved = await getTestDb()
        .select()
        .from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.role, "user")));
      expect(saved).toHaveLength(1);
      expect(saved[0]!.parts.timeZone).toBe("Asia/Kolkata");
      const triggers = await getTestDb()
        .select()
        .from(botTrigger)
        .where(eq(botTrigger.conversationId, conversationId));
      expect(triggers.map((trigger) => [trigger.id, trigger.botId])).toEqual([[id, scout.id]]);
      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "refuses an id a Message elsewhere holds",
    async () => {
      const { client, scout, room } = await threeBotRoom([says("Hi.")]);
      const id = uuidv7();
      await client.bots.send({ botId: scout.id, id, text: "Alone" });
      await expect(
        client.rooms.send({ conversationId: room.conversationId, id, text: "Together" }),
      ).rejects.toMatchObject({ data: { code: "error.messageIdTaken" } });
      expect(await oneToOneOf(scout.id)).not.toBe(room.conversationId);
    },
    timeout,
  );
});

/** `fake`'s adapter, holding each call until `open()`, or until its Turn is stopped. */
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
  return { adapter, entered, open: () => open() };
}

/** Holds Conversation `conversationId`'s row lock in a transaction of its own until `release()`. */
async function holdLock(conversationId: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = getTestDb().transaction(async (tx) => {
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .for("update");
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** How many sessions of this database wait on a lock. */
const lockWaits = async () => {
  const { rows } = await getTestDb().execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
};

/** Whether Conversation `conversationId`'s row lock is free now. */
const lockIsFree = (conversationId: string) =>
  getTestDb().transaction(async (tx) => {
    try {
      await tx.execute(
        sql`select ${conversation.id} from ${conversation} where ${conversation.id} = ${conversationId} for update nowait`,
      );
      return true;
    } catch {
      return false;
    }
  });

describe("Conversation row locks", () => {
  it(
    "a Room Turn's end takes its Bot's 1:1 lock before the Room's, as a pause does",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [says("Done.")] }));
      const { client, scout, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      await client.rooms.send({ conversationId, text: "Go" });
      await expect.poll(() => gate.entered.length, poll).toBe(1);

      // A pause holds the 1:1's lock and is about to take the Room's (`lockConversations`).
      const pause = await holdLock(await oneToOneOf(scout.id));
      gate.open();
      await expect.poll(lockWaits, poll).toBeGreaterThan(0);
      // The Turn's end waits for the 1:1 holding nothing in the Room, so the pause goes on.
      const free = await lockIsFree(conversationId);
      await pause.release();

      expect(free).toBe(true);
      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["complete"]);
    },
    timeout,
  );
});
