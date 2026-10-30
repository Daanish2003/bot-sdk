import type { TextOptions } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { appendBotMessage, textParts } from "../../src/bot/conversation/store";
import { findBot } from "../../src/bot/conversation";
import { latestPromptStart } from "../../src/bot/context/prompt-start";
import {
  bot,
  botPromptStart,
  botRoomMember,
  botSummary,
  botTrigger,
  botTurn,
  message,
} from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { emailChannel, webPushChannel } from "../../src/channel";
import { saveCredentials } from "../../src/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeEmailProvider, fakePushProvider } from "@botsdk/testing/fake-channel";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

/*
 * Each Bot's own controls in a Room (spec #1055): pause, reset, the Tasks view and notifications.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;
const domain = "bots.example";
const appUrl = "https://app.example";
// 09:00 UTC is 02:00 in Los Angeles (summer time), inside the night below.
const at = new Date("2026-10-22T09:00:00.000Z");
const night = { start: "22:00", end: "07:00" };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const says = (text: string) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn: true } }));

/** A user with Scout and Writer, in the Rooms "Launch" and "Ship", on a fixed clock. */
async function roomed(rounds: Round[] = [], { runner = false } = {}) {
  const timer = fakeJobClock(at);
  const fake = createFakeAdapter({ rounds });
  const email = fakeEmailProvider();
  const push = fakePushProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  const user = await insertUser();
  deps = createTestSdk({
    channels: [
      emailChannel({ provider: email.provider, domain, appUrl }),
      webPushChannel({ provider: push.provider, appUrl }),
    ],
    users: { verifiedEmail: async (userId) => (userId === user.id ? "ada@example.com" : null) },
    jobs,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    logger: silent,
    memory: false,
  });
  if (runner) {
    await jobs.start();
    started.push(jobs);
  }
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const scout = await client.bots.create({ name: "Scout", model });
  const writer = await client.bots.create({ name: "Writer", model });
  const launch = await client.rooms.create({ name: "Launch", botIds: [scout.id, writer.id] });
  const ship = await client.rooms.create({ name: "Ship", botIds: [scout.id, writer.id] });
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  return {
    fake,
    deps,
    jobs,
    timer,
    email,
    push,
    user,
    client,
    scout,
    writer,
    launch,
    ship,
    runDue,
  };
}

const turnsOf = (botId: string, conversationId?: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, botId),
        conversationId ? eq(botTurn.conversationId, conversationId) : undefined,
      ),
    );

const userTextsOf = (call: TextOptions) => JSON.stringify(call.messages);

describe("pausing a Bot in a Room", () => {
  it(
    "keeps a paused member from answering, and it resumes normally",
    async () => {
      const { client, fake, timer, runDue, scout, launch } = await roomed([says("Back.")]);
      await client.bots.pause({ botId: scout.id });
      expect(
        (await client.rooms.get({ conversationId: launch.conversationId })).room.members,
      ).toMatchObject([
        { name: "Scout", status: "paused" },
        { name: "Writer", status: null },
      ]);

      await client.rooms.send({ conversationId: launch.conversationId, text: "Anyone?" });

      expect(await turnsOf(scout.id)).toEqual([]);
      const [skipped] = await getTestDb()
        .select()
        .from(botTrigger)
        .where(eq(botTrigger.botId, scout.id));
      expect(skipped).toMatchObject({
        skipReason: "paused",
        conversationId: launch.conversationId,
      });

      await client.bots.resume({ botId: scout.id });
      await client.rooms.send({ conversationId: launch.conversationId, text: "Now?" });
      timer.advance(3_000);
      await runDue();
      expect((await turnsOf(scout.id)).map((turn) => turn.status)).toEqual(["complete"]);
      expect(fake.calls.filter(isTurnCall)).toHaveLength(1);
    },
    timeout,
  );

  it(
    "stops its running Turn and skips what waits in every Room it is in",
    async () => {
      const { client, scout, launch, ship } = await roomed([]);
      await client.rooms.send({ conversationId: launch.conversationId, text: "Start." });
      expect((await turnsOf(scout.id, launch.conversationId)).map((turn) => turn.status)).toEqual([
        "running",
      ]);
      await getTestDb().insert(botTrigger).values({
        id: uuidv7(),
        botId: scout.id,
        conversationId: ship.conversationId,
        source: "routine",
        channel: "schedule",
        text: "x",
        receivedAt: at,
      });

      await client.bots.pause({ botId: scout.id });

      expect((await turnsOf(scout.id, launch.conversationId)).map((turn) => turn.status)).toEqual([
        "stopped",
      ]);
      const triggers = await getTestDb()
        .select({ reason: botTrigger.skipReason, conversationId: botTrigger.conversationId })
        .from(botTrigger)
        .where(eq(botTrigger.botId, scout.id));
      expect(triggers).toHaveLength(2);
      expect(triggers.every((trigger) => trigger.reason === "paused")).toBe(true);
    },
    timeout,
  );
});

describe("resetting a Bot in a Room", () => {
  it(
    "posts no Message in its Rooms, and sets the reset point on all of its member rows",
    async () => {
      const { client, scout, writer, launch, ship } = await roomed();
      const before = await client.rooms.get({ conversationId: launch.conversationId });

      await client.bots.reset({ botId: scout.id, name: "Scout" });

      for (const room of [launch, ship]) {
        const marks = await getTestDb()
          .select({ botId: botRoomMember.botId, resetAt: botRoomMember.resetAt })
          .from(botRoomMember)
          .where(eq(botRoomMember.conversationId, room.conversationId));
        expect(marks.find((row) => row.botId === scout.id)?.resetAt).toEqual(at);
        expect(marks.find((row) => row.botId === writer.id)?.resetAt).toBeNull();
        const reset = await getTestDb()
          .select({ id: message.id })
          .from(message)
          .where(and(eq(message.conversationId, room.conversationId), eq(message.role, "reset")));
        expect(reset).toEqual([]);
      }
      expect((await client.rooms.get({ conversationId: launch.conversationId })).messages).toEqual(
        before.messages,
      );
      // The 1:1 Conversation keeps its reset mark.
      const { conversationId } = (await findBot(
        getTestDb(),
        (await getTestDb().select().from(bot).where(eq(bot.id, scout.id)))[0]!.userId,
        scout.id,
      ))!;
      const marks = await getTestDb()
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.role, "reset")));
      expect(marks).toHaveLength(1);
    },
    timeout,
  );

  it(
    "starts the Bot's next Room input after the reset point, while others still see the earlier Messages",
    async () => {
      const { fake, timer, runDue, client, scout, launch } = await roomed([
        says("First."),
        says("Second."),
        says("Third."),
      ]);
      const room = launch.conversationId;
      const run = async () => {
        timer.advance(3_000);
        await runDue();
      };
      await client.rooms.send({ conversationId: room, text: "Before the reset." });
      await run();
      expect((await turnsOf(scout.id)).map((turn) => turn.status)).toEqual(["complete"]);
      await client.bots.reset({ botId: scout.id, name: "Scout" });
      timer.advance(3_000);

      await client.rooms.send({ conversationId: room, text: "After it." });
      await run();
      await client.rooms.send({ conversationId: room, text: "@Writer what did I say first?" });
      await run();
      expect(fake.calls.filter(isTurnCall)).toHaveLength(3);

      const [, scoutAfter, writerFirst] = fake.calls.filter(isTurnCall);
      expect(userTextsOf(scoutAfter!)).toContain("After it.");
      expect(userTextsOf(scoutAfter!)).not.toContain("Before the reset.");
      expect(userTextsOf(writerFirst!)).toContain("Before the reset.");
      // The user still sees everything.
      const { messages } = await client.rooms.get({ conversationId: launch.conversationId });
      expect(messages.map((one) => one.text)).toContain("Before the reset.");
    },
    timeout,
  );
});

describe("the Tasks view", () => {
  it(
    "lists a Bot's waiting Triggers in every Conversation",
    async () => {
      const { client, scout, launch } = await roomed([]);
      const id = uuidv7();
      await getTestDb().insert(botTrigger).values({
        id,
        botId: scout.id,
        conversationId: launch.conversationId,
        source: "user",
        channel: "web",
        receivedAt: at,
      });

      const tasks = await client.bots.tasks({ botId: scout.id });

      expect(tasks.scheduled.triggers.map((trigger) => trigger.id)).toEqual([id]);
    },
    timeout,
  );
});

describe("a Bot's Room Message", () => {
  /** Posts a Message from Scout in the Room with no Turn, then runs the deliveries due. */
  async function post(
    setup: Awaited<ReturnType<typeof roomed>>,
    settings: Parameters<ReturnType<typeof chatRpc>["notifications"]["update"]>[0],
  ) {
    const { client, deps, scout, launch, runDue, timer } = setup;
    await client.notifications.push.subscribe({
      endpoint: "https://push.example/send/laptop",
      keys: { p256dh: "Blaptop".padEnd(87, "A"), auth: "alaptop".padEnd(22, "A") },
    });
    await client.notifications.update(settings);
    await deps.db.transaction((tx) =>
      appendBotMessage(
        deps,
        tx,
        { botId: scout.id, conversationId: launch.conversationId },
        { parts: textParts("Heads up."), createdAt: timer.clock.now(), turnId: null },
      ),
    );
    await runDue();
  }

  it(
    "is pushed with the Room and the Bot's name, opening the Room",
    async () => {
      const setup = await roomed([]);

      await post(setup, { quietHours: null, urgent: null, other: "push" });

      expect(setup.push.sent.map((one) => one.notification)).toMatchObject([
        {
          title: "Launch · Scout",
          body: "Heads up.",
          url: `${appUrl}/bots/rooms/${setup.launch.conversationId}`,
        },
      ]);
    },
    timeout,
  );

  it(
    "is emailed under the Room and the Bot's name",
    async () => {
      const setup = await roomed([]);

      await post(setup, { quietHours: null, urgent: null, other: "email" });

      expect(setup.email.sent).toHaveLength(1);
      expect(setup.email.sent[0]).toMatchObject({ subject: "Launch · Scout" });
      expect(setup.email.sent[0]!.from).toContain("Scout");
    },
    timeout,
  );

  it(
    "is held back during quiet hours, in the zone the user last wrote from",
    async () => {
      const setup = await roomed([]);
      await setup.client.bots.send({
        botId: setup.writer.id,
        id: uuidv7(),
        text: "Hi",
        timeZone: "America/Los_Angeles",
      });

      await post(setup, { quietHours: night, urgent: null, other: "push" });

      expect(setup.push.sent).toEqual([]);
    },
    timeout,
  );
});

describe("a Bot's Room reply to a handoff", () => {
  it(
    "goes where the user last wrote in the Room: on the web, it stays in the app",
    async () => {
      const setup = await roomed([says("@Writer, over to you."), says("Done.")]);
      const { client, writer, launch, timer, runDue, push, email } = setup;
      await client.notifications.push.subscribe({
        endpoint: "https://push.example/send/laptop",
        keys: { p256dh: "Blaptop".padEnd(87, "A"), auth: "alaptop".padEnd(22, "A") },
      });
      await client.notifications.update({ quietHours: null, urgent: null, other: "push" });

      await client.rooms.send({ conversationId: launch.conversationId, text: "Start the launch" });
      for (let round = 0; round < 6; round++) {
        timer.advance(1_000);
        await runDue();
      }

      const [handedOn] = await turnsOf(writer.id, launch.conversationId);
      expect(handedOn?.status).toBe("complete");
      const [taken] = await getTestDb()
        .select()
        .from(botTrigger)
        .where(eq(botTrigger.turnId, handedOn!.id));
      expect(taken?.source).toBe("agent");
      expect(push.sent).toEqual([]);
      expect(email.sent).toEqual([]);
    },
    timeout,
  );
});

describe("a Bot's Room reply to a handoff, after the user wrote by email", () => {
  it(
    "is emailed, as the Room's thread goes on by email",
    async () => {
      const setup = await roomed([says("@Writer, over to you."), says("Done.")]);
      const { client, deps, scout, launch, timer, runDue, push, email } = setup;
      await client.notifications.push.subscribe({
        endpoint: "https://push.example/send/laptop",
        keys: { p256dh: "Blaptop".padEnd(87, "A"), auth: "alaptop".padEnd(22, "A") },
      });
      await client.notifications.update({ quietHours: null, urgent: null, other: "push" });
      const posted = await deps.db.transaction((tx) =>
        appendBotMessage(
          deps,
          tx,
          { botId: scout.id, conversationId: launch.conversationId },
          { parts: textParts("Draft ready."), createdAt: timer.clock.now(), turnId: null },
        ),
      );
      const { address } = await client.channels.email.address({ botId: scout.id });
      const mail = await email.provider.parseInbound(
        email.request({
          from: "Ada <ada@example.com>",
          to: [address],
          messageId: "<first@mail.example>",
          subject: "Launch",
          text: "Start the launch",
          headers: { "In-Reply-To": `<${posted}@${domain}>` },
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        }),
      );
      if ("rejected" in mail) throw new Error(mail.rejected);

      await deps.channels.receive("email", mail);
      for (let round = 0; round < 6; round++) {
        timer.advance(1_000);
        await runDue();
      }

      // Only the Message the user replied to, which no Turn of theirs started, was pushed.
      expect(push.sent.map((one) => one.notification.body)).toEqual(["Draft ready."]);
      // Each in the thread: Scout answers the user's mail, Writer the latest one, Scout's.
      expect(email.sent).toMatchObject([
        { from: expect.stringContaining("Scout"), inReplyTo: "<first@mail.example>" },
        {
          from: expect.stringContaining("Writer"),
          inReplyTo: `<${email.sent[0]?.messageId.slice(1, -1)}>`,
        },
      ]);
    },
    timeout,
  );
});

describe("a Prompt start with a Summary", () => {
  it(
    "belongs to the Conversation its Summary was written in, so a Room's text never reaches another Turn",
    async () => {
      const { scout, launch, ship, user } = await roomed();
      const db = getTestDb();
      const { conversationId: own } = (await findBot(db, user.id, scout.id))!;
      const t = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
      const turnId = uuidv7();
      await db.insert(botTurn).values({
        id: turnId,
        botId: scout.id,
        conversationId: launch.conversationId,
        status: "complete",
        startedAt: t(0),
        endedAt: t(1),
      });
      const start = async (minutes: number, summary?: { kind: "away" | "mid_turn" }) => {
        const summaryId = summary ? uuidv7() : null;
        if (summaryId && summary) {
          await db.insert(botSummary).values({
            id: summaryId,
            botId: scout.id,
            text: "Room secrets.",
            coversUntil: t(minutes),
            kind: summary.kind,
            turnId: summary.kind === "mid_turn" ? turnId : null,
            createdAt: t(minutes),
          });
        }
        const id = uuidv7();
        await db
          .insert(botPromptStart)
          .values({ id, botId: scout.id, builtAt: t(minutes), summaryId, tools: [], sections: [] });
        return id;
      };
      const first = await start(0);
      const inLaunch = await start(1, { kind: "mid_turn" });

      expect((await latestPromptStart(db, scout.id))?.id).toBe(first);
      expect((await latestPromptStart(db, scout.id, own))?.id).toBe(first);
      expect((await latestPromptStart(db, scout.id, ship.conversationId))?.id).toBe(first);
      expect((await latestPromptStart(db, scout.id, launch.conversationId))?.id).toBe(inLaunch);

      // An away Summary is about the Bot's 1:1 Conversation.
      const away = await start(2, { kind: "away" });
      expect((await latestPromptStart(db, scout.id))?.id).toBe(away);
      expect((await latestPromptStart(db, scout.id, launch.conversationId))?.id).toBe(inLaunch);
    },
    timeout,
  );
});
