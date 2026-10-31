import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot, botReview, botTrigger, botTurn, conversation, job, message } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { lockConversationSet } from "../../src/bot/triggers";
import { postToRoom } from "../../src/bot/turn/turn";
import { exportUserData } from "../../src/user-data";
import { conversationChannel } from "../../src/chat/conversation-events";
import type { BotExport } from "../../src/bot/conversation";
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
    memory: false,
    // The shell needs the Computer.
    computer: fakeComputerProvider().provider,
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

/**
 * `fake`'s adapter, holding each call after the first `passes` until `open()`, or until its Turn is
 * stopped.
 */
function held(fake: FakeAdapter, passes = 0) {
  const entered: TextOptions[] = [];
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const adapter: typeof fake.adapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      if (entered.length <= passes) return yield* fake.adapter.chatStream(options);
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
    "a lock set read before its locks is read again after them, and taken again in order when it moved",
    async () => {
      const { scout, writer, room } = await threeBotRoom();
      const ids = [room.conversationId, await oneToOneOf(scout.id), await oneToOneOf(writer.id)];
      // The set grows once, as a member added between the read and the locks makes it.
      const reads: string[][] = [];
      const read = async () => {
        const now = reads.length === 0 ? ids.slice(0, 2) : ids;
        reads.push(now);
        return now;
      };
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: (taken: string[]) => void = () => {};
      const taken = new Promise<string[]>((resolve) => {
        locked = resolve;
      });
      const done = getTestDb().transaction(async (tx) => {
        locked(await lockConversationSet(tx, read));
        await released;
      });

      expect([...(await taken)].sort()).toEqual([...ids].sort());
      // Read, read again (moved), then read and read again (the same).
      expect(reads.map((set) => set.length)).toEqual([2, 3, 3, 3]);
      expect(await Promise.all(ids.map(lockIsFree))).toEqual([false, false, false]);
      release();
      await done;
      expect(await Promise.all(ids.map(lockIsFree))).toEqual([true, true, true]);
    },
    timeout,
  );

  it(
    "a lock set that keeps moving through its last try is read again until it holds still, leaving nothing out",
    async () => {
      const { scout, writer, ops, room } = await threeBotRoom();
      const ids = [
        room.conversationId,
        await oneToOneOf(scout.id),
        await oneToOneOf(writer.id),
        await oneToOneOf(ops.id),
      ];
      // Sizes 1, 2 (moved), 1, 2 (moved), 1, 2 (moved, the last try), 3, 4, 4: each read after the
      // last try's locks finds one more, until two reads agree.
      const sizes = [1, 2, 1, 2, 1, 2, 3, 4, 4];
      const reads: number[] = [];
      const read = async () => {
        const size = sizes[reads.length] ?? 4;
        reads.push(size);
        return ids.slice(0, size);
      };
      const taken = await getTestDb().transaction((tx) => lockConversationSet(tx, read));

      expect([...taken].sort()).toEqual([...ids].sort());
      expect(reads).toEqual(sizes);
    },
    timeout,
  );

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

/**
 * A running Turn ends once its attempt sees the cancel, at its next heartbeat (every 10 s), so a
 * wait for it allows one heartbeat and the time to end the Turn.
 */
const heartbeat = { timeout: 20_000 };

/** The status of Turn `turnId`'s job: `cancelled` as soon as a Stop commits. */
const jobOf = async (turnId: string) => {
  const [row] = await getTestDb()
    .select({ status: job.status })
    .from(job)
    .where(eq(job.idempotencyKey, turnId));
  return row?.status;
};

/** The id of Bot `botId`'s only Turn in Conversation `conversationId`. */
const turnIn = async (botId: string, conversationId: string) =>
  (await turnsOf(botId, conversationId))[0]!.id;

describe("stopping a Bot's Turns", () => {
  it(
    "a Ban ends the user's Room Turns as well as their 1:1 Turns",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [] }));
      const { client, deps, user, scout, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Alone" });
      await client.rooms.send({ conversationId, text: "@Scout @Writer go" });
      await expect.poll(() => gate.entered.length, poll).toBe(3);

      await deps.bots.stopTurns({ userId: user.id });

      const own = await oneToOneOf(scout.id);
      const stopped = async () => [
        ...(await statusesOf(scout.id, conversationId)),
        ...(await statusesOf(writer.id, conversationId)),
        ...(await statusesOf(scout.id, own)),
      ];
      await expect.poll(stopped, heartbeat).toEqual(["stopped", "stopped", "stopped"]);
    },
    timeout,
  );

  it(
    "bots.stop with a Conversation stops the Bot's Turn there, and only there",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [] }));
      const { client, scout, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      const own = await oneToOneOf(scout.id);
      await client.bots.send({ botId: scout.id, id: uuidv7(), text: "Alone" });
      await client.rooms.send({ conversationId, text: "@Scout @Writer go" });
      await expect.poll(() => gate.entered.length, poll).toBe(3);
      // The Tasks view shows the Turn with its Conversation, for its Stop.
      const tasks = await client.bots.tasks({ botId: writer.id });
      expect(tasks.inProgress.turn).toMatchObject({ conversationId });
      const [inRoom, alone, writers] = await Promise.all([
        turnIn(scout.id, conversationId),
        turnIn(scout.id, own),
        turnIn(writer.id, conversationId),
      ]);

      await client.bots.stop({ botId: scout.id, conversationId });

      expect([await jobOf(inRoom), await jobOf(alone), await jobOf(writers)]).toEqual([
        "cancelled",
        "running",
        "running",
      ]);
      // Without one, it stops the 1:1 Turn, as before.
      await client.bots.stop({ botId: scout.id });
      expect([await jobOf(alone), await jobOf(writers)]).toEqual(["cancelled", "running"]);
      // A Conversation the Bot isn't in is not found.
      const other = await client.rooms.create({
        name: "Other",
        botIds: [writer.id, room.members[2]!.botId],
      });
      await expect(
        client.bots.stop({ botId: scout.id, conversationId: other.conversationId }),
      ).rejects.toMatchObject({ data: { code: "error.roomNotFound" } });
      const ended = async () => [
        ...(await statusesOf(scout.id, conversationId)),
        ...(await statusesOf(scout.id, own)),
      ];
      await expect.poll(ended, heartbeat).toEqual(["stopped", "stopped"]);
      expect(await statusesOf(writer.id, conversationId)).toEqual(["running"]);
    },
    timeout,
  );
});

describe("an Approval answered after its Bot left the Room", () => {
  it(
    "wakes the Bot in its 1:1, and nothing of it lands in the Room",
    async () => {
      const reviewer = fakeReviewer(() =>
        verdictRound({ outcome: "block", reason: "Not asked.", summary: "Deploy" }),
      );
      const { client, writer, room } = await threeBotRoom(
        [
          round(toolCall({ name: "shell", input: { command: "make deploy" } })),
          says("Okay."),
          says("Noted."),
        ],
        undefined,
        reviewer,
      );
      const conversationId = room.conversationId;
      const own = await oneToOneOf(writer.id);
      const reviewOf = async () => {
        const [row] = await getTestDb()
          .select()
          .from(botReview)
          .where(eq(botReview.botId, writer.id));
        return row;
      };
      await client.rooms.send({ conversationId, text: "@Writer, deploy it." });
      await expect.poll(async () => (await reviewOf())?.state, poll).toBe("waiting");
      // The user's next Message interrupts the wait: the Approval stays open, pending (ADR 0030).
      await client.rooms.send({ conversationId, text: "@Writer, hold on." });
      await expect
        .poll(() => statusesOf(writer.id, conversationId), poll)
        .toEqual(["stopped", "complete"]);
      expect((await reviewOf())?.state).toBe("pending");
      await client.rooms.removeMember({ conversationId, botId: writer.id });
      const roomMessages = async () =>
        (await getTestDb().select().from(message).where(eq(message.conversationId, conversationId)))
          .length;
      const before = await roomMessages();

      await client.reviews.deny({ reviewId: (await reviewOf())!.id });

      await expect.poll(() => statusesOf(writer.id, own), poll).toEqual(["complete"]);
      const approvals = await getTestDb()
        .select()
        .from(botTrigger)
        .where(and(eq(botTrigger.botId, writer.id), eq(botTrigger.source, "approval")));
      expect(approvals.map((trigger) => trigger.conversationId)).toEqual([own]);
      expect(await roomMessages()).toBe(before);
    },
    timeout,
  );
});

describe("the user's data export", () => {
  it(
    "holds their Rooms: each name, its members and its Messages with their authors",
    async () => {
      const { deps, user, scout, writer, ops, client, room } = await threeBotRoom([
        says("Plan drafted."),
      ]);
      const conversationId = room.conversationId;
      await client.rooms.send({ conversationId, text: "Plan the launch" });
      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["complete"]);
      // Another user's Room is not in it.
      const other = await insertUser();
      await saveCredentials(deps, other.id, {
        service: "openai",
        fields: { apiKey: "openai-test-key" },
        hint: "…-key",
        verified: true,
      });
      const stranger = chatRpc({ user: other, deps });
      const a = await stranger.bots.create({ name: "A", model });
      const b = await stranger.bots.create({ name: "B", model });
      await stranger.rooms.create({ name: "Theirs", botIds: [a.id, b.id] });

      const { rooms, bots } = (await exportUserData(deps, user.id)).bot as BotExport;

      expect(rooms).toEqual([
        {
          conversationId,
          name: "Launch",
          createdAt: expect.any(Date),
          members: [
            { botId: scout.id, name: "Scout", lead: true },
            { botId: writer.id, name: "Writer", lead: false },
            { botId: ops.id, name: "Ops", lead: false },
          ],
          messages: [
            expect.objectContaining({ role: "user", text: "Plan the launch" }),
            expect.objectContaining({
              role: "assistant",
              text: "Plan drafted.",
              authorBotId: scout.id,
            }),
          ],
        },
      ]);
      // The 1:1 Conversations are still each Bot's own.
      expect(bots.map((row) => row.messages)).toEqual([[], [], []]);
    },
    timeout,
  );

  it(
    "keeps a Room whose Bots were all deleted, with its Messages",
    async () => {
      const { deps, user, scout, writer, ops, client, room } = await threeBotRoom([
        says("Plan drafted."),
      ]);
      const conversationId = room.conversationId;
      await client.rooms.send({ conversationId, text: "Plan the launch" });
      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["complete"]);
      // A Bot is deleted with its 1:1 Conversation, by cascade.
      const owned = await Promise.all([scout, writer, ops].map((one) => oneToOneOf(one.id)));
      await getTestDb().delete(conversation).where(inArray(conversation.id, owned));

      const { rooms, bots } = (await exportUserData(deps, user.id)).bot as BotExport;

      expect(bots).toEqual([]);
      expect(rooms).toMatchObject([
        { conversationId, name: "Launch", members: [], messages: [{}, {}] },
      ]);
    },
    timeout,
  );
});

describe("a Bot's page, its 1:1 Conversation", () => {
  it(
    "reads the 1:1's Turn status, so a Room Turn shows no Stop there, and its log carries no Room Turn's status",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [says("Done.")] }));
      const { deps, client, scout, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      const hints: string[] = [];
      await deps.pubsub.subscribe(conversationChannel(await oneToOneOf(scout.id)), (hint) => {
        hints.push(hint);
      });
      await client.rooms.send({ conversationId, text: "Go" });
      await expect.poll(() => gate.entered.length, poll).toBe(1);
      // The Bot's thread is told of the Room Turn's start, and of its end below.
      await expect.poll(() => hints.length, poll).toBe(1);

      expect((await client.bots.get({ botId: scout.id })).bot.turnStatus).toBeNull();
      // Its start hints the Bot's thread already, so its Tasks view shows the running Room Turn.
      const started = await client.conversations.changes({
        conversationId: await oneToOneOf(scout.id),
        since: 0,
      });
      if (started.reload) throw new Error("expected changes");
      expect(started.changes.filter((change) => change.kind === "turn")).toHaveLength(1);
      gate.open();
      await expect.poll(() => statusesOf(scout.id, conversationId), poll).toEqual(["complete"]);
      await expect.poll(() => hints.length, poll).toBe(2);

      // The Room Turn's end still hints the Bot's thread (its Tasks view), with no status to show.
      const logged = await client.conversations.changes({
        conversationId: await oneToOneOf(scout.id),
        since: 0,
      });
      if (logged.reload) throw new Error("expected changes");
      const turns = logged.changes.filter((change) => change.kind === "turn");
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.map((change) => change.data)).toEqual(turns.map(() => null));
      expect((await client.bots.get({ botId: scout.id })).bot.turnStatus).toBeNull();
    },
    timeout,
  );
});

/** Hints to Bot `botId`'s 1:1 thread from now on, as its open Tasks view gets them. */
async function hintsTo(deps: TestDeps, botId: string) {
  const hints: string[] = [];
  await deps.pubsub.subscribe(conversationChannel(await oneToOneOf(botId)), (hint) => {
    hints.push(hint);
  });
  return hints;
}

/** The Turns whose `turn` changes Bot `botId`'s 1:1 log holds. */
async function turnChangesOf(client: ReturnType<typeof chatRpc>, botId: string) {
  const read = await client.conversations.changes({
    conversationId: await oneToOneOf(botId),
    since: 0,
  });
  if (read.reload) throw new Error("expected changes");
  return read.changes.filter((change) => change.kind === "turn").map((change) => change.refId);
}

/**
 * Expects Bot `botId`'s Turn running in `conversationId` to be in its 1:1 log, and its thread to
 * have had `count` hints: its Tasks view lists the running Room Turn at once.
 */
async function expectRunningInOneToOne(
  client: ReturnType<typeof chatRpc>,
  hints: string[],
  { botId, conversationId, count }: { botId: string; conversationId: string; count: number },
) {
  await expect.poll(() => hints.length, poll).toBe(count);
  const running = (await turnsOf(botId, conversationId)).filter(
    (turn) => turn.status === "running",
  );
  expect(running).toHaveLength(1);
  expect(await turnChangesOf(client, botId)).toContain(running[0]!.id);
}

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

/** A round in which the Bot asks the user to pick red or blue. */
const asksColour = round(
  toolCall({
    name: "send_to_user",
    input: {
      text: "Red or blue?",
      endTurn: true,
      choice: { options: ["Red", "Blue"], other: false },
    },
  }),
);

describe("a Room Turn's start, in its Bot's 1:1 thread", () => {
  it(
    "is hinted to the Bot's thread when a user Message starts it",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [says("Done.")] }));
      const { deps, client, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      const hints = await hintsTo(deps, writer.id);

      await client.rooms.send({ conversationId, text: "@Writer, go." });

      await expect.poll(() => gate.entered.length, poll).toBe(1);
      await expectRunningInOneToOne(client, hints, { botId: writer.id, conversationId, count: 1 });
      gate.open();
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["complete"]);
      // Its end is hinted too.
      await expect.poll(() => hints.length, poll).toBe(2);
    },
    timeout,
  );

  it(
    "is hinted to the Bot's thread when another Bot's handoff starts it",
    async () => {
      const gate = held(
        createFakeAdapter({ rounds: [says("Found it. @Writer, draft it."), says("Drafted.")] }),
        1,
      );
      const { deps, client, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      const hints = await hintsTo(deps, writer.id);

      await client.rooms.send({ conversationId, text: "@Scout, find the notes." });

      await expect.poll(() => gate.entered.length, poll).toBe(2);
      await expectRunningInOneToOne(client, hints, { botId: writer.id, conversationId, count: 1 });
      gate.open();
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "is hinted to the Bot's thread when the user's choice starts it",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [asksColour, says("Red it is.")] }), 1);
      const { deps, client, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      const hints = await hintsTo(deps, writer.id);
      await client.rooms.send({ conversationId, text: "@Writer, which colour?" });
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["complete"]);
      // The first Turn's start and end.
      await expect.poll(() => hints.length, poll).toBe(2);
      const { messages } = await client.rooms.get({ conversationId });
      const asked = messages.findLast((entry) => entry.control?.kind === "choice")!;

      await client.bots.choose({
        botId: writer.id,
        messageId: asked.id,
        answer: { option: "Red" },
      });

      await expectRunningInOneToOne(client, hints, { botId: writer.id, conversationId, count: 3 });
      gate.open();
      await expect
        .poll(() => statusesOf(writer.id, conversationId), poll)
        .toEqual(["complete", "complete"]);
    },
    timeout,
  );

  it(
    "is hinted to the Bot's thread when a Helper's report starts it",
    async () => {
      const turns = held(
        createFakeAdapter({
          rounds: [
            round(toolCall({ name: "start_helper", input: { type: "general", task: "Count." } })),
            says("On it."),
            says("The count is 3."),
          ],
        }),
        2,
      );
      const helpers = createFakeAdapter({ rounds: [round(text("Counted 3."))], manual: true });
      const adapter = {
        ...turns.adapter,
        chatStream: (options: TextOptions) =>
          isHelperCall(options)
            ? helpers.adapter.chatStream(options)
            : turns.adapter.chatStream(options),
      } as AnyTextAdapter;
      const { deps, client, writer, room } = await threeBotRoom([], adapter);
      const conversationId = room.conversationId;
      const hints = await hintsTo(deps, writer.id);
      await client.rooms.send({ conversationId, text: "@Writer, count the files." });
      await expect.poll(() => helpers.calls.length, poll).toBe(1);
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["complete"]);
      await expect.poll(() => hints.length, poll).toBe(2);

      await helpers.releaseAll();

      await expectRunningInOneToOne(client, hints, { botId: writer.id, conversationId, count: 3 });
      turns.open();
      await expect
        .poll(() => statusesOf(writer.id, conversationId), poll)
        .toEqual(["complete", "complete"]);
    },
    timeout,
  );

  for (const answer of ["allow", "deny"] as const) {
    it(
      `is hinted to the Bot's thread when a late Approval answer (${answer}) starts it`,
      async () => {
        const reviewer = fakeReviewer(() =>
          verdictRound({ outcome: "block", reason: "Not asked.", summary: "Deploy" }),
        );
        const gate = held(
          createFakeAdapter({
            rounds: [
              round(toolCall({ name: "shell", input: { command: "make deploy" } })),
              says("Okay."),
              says("Noted."),
            ],
          }),
          2,
        );
        const { deps, client, writer, room } = await threeBotRoom([], gate.adapter, reviewer);
        const conversationId = room.conversationId;
        const hints = await hintsTo(deps, writer.id);
        const reviewOf = async () => {
          const [row] = await getTestDb()
            .select()
            .from(botReview)
            .where(eq(botReview.botId, writer.id));
          return row;
        };
        await client.rooms.send({ conversationId, text: "@Writer, deploy it." });
        await expect.poll(async () => (await reviewOf())?.state, poll).toBe("waiting");
        // The user's next Message interrupts the wait: the Approval goes pending (ADR 0030).
        await client.rooms.send({ conversationId, text: "@Writer, hold on." });
        await expect
          .poll(() => statusesOf(writer.id, conversationId), poll)
          .toEqual(["stopped", "complete"]);
        // The first Turn's start, its end (which started the next), and the next one's end.
        await expect.poll(() => hints.length, poll).toBe(3);

        await client.reviews[answer]({ reviewId: (await reviewOf())!.id });

        await expectRunningInOneToOne(client, hints, {
          botId: writer.id,
          conversationId,
          count: 4,
        });
        gate.open();
        await expect
          .poll(() => statusesOf(writer.id, conversationId), poll)
          .toEqual(["stopped", "complete", "complete"]);
      },
      timeout,
    );
  }

  it(
    "a choice answered in a Room takes its Bot's 1:1 lock before the Room's",
    async () => {
      const gate = held(createFakeAdapter({ rounds: [asksColour, says("Red it is.")] }), 1);
      const { client, writer, room } = await threeBotRoom([], gate.adapter);
      const conversationId = room.conversationId;
      await client.rooms.send({ conversationId, text: "@Writer, which colour?" });
      await expect.poll(() => statusesOf(writer.id, conversationId), poll).toEqual(["complete"]);
      const { messages } = await client.rooms.get({ conversationId });
      const asked = messages.findLast((entry) => entry.control?.kind === "choice")!;
      // The 1:1 was made before the Room, so its id comes first.
      const own = await oneToOneOf(writer.id);
      expect(own < conversationId).toBe(true);

      // A pause holds the 1:1's lock and is about to take the Room's.
      const pause = await holdLock(own);
      const chosen = client.bots.choose({
        botId: writer.id,
        messageId: asked.id,
        answer: { option: "Red" },
      });
      await expect.poll(lockWaits, poll).toBeGreaterThan(0);
      // The answer waits for the 1:1 holding nothing in the Room, so the pause goes on.
      const free = await lockIsFree(conversationId);
      await pause.release();
      await chosen;

      expect(free).toBe(true);
      gate.open();
      await expect
        .poll(() => statusesOf(writer.id, conversationId), poll)
        .toEqual(["complete", "complete"]);
    },
    timeout,
  );
});
describe("a Message posted to a Room from a Channel", () => {
  it(
    "is refused under the Room's lock when its stillValid check says no, saving nothing",
    async () => {
      const { deps, user, room } = await threeBotRoom();
      const conversationId = room.conversationId;

      const posted = await postToRoom(deps, {
        userId: user.id,
        conversationId,
        triggerId: "email:rotated@mail.example",
        text: "Hello",
        channel: "email",
        stillValid: async () => false,
      });

      expect(posted).toEqual({ outcome: "refused" });
      expect(
        await getTestDb().select().from(message).where(eq(message.conversationId, conversationId)),
      ).toEqual([]);
      expect(
        await getTestDb()
          .select()
          .from(botTrigger)
          .where(eq(botTrigger.conversationId, conversationId)),
      ).toEqual([]);
    },
    timeout,
  );
});
