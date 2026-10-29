import { and, asc, eq, inArray, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { appendMessage } from "../../src/chat/message-tree";
import {
  botCheckIn,
  botHelper,
  botReview,
  botRoutine,
  botTrigger,
  botTurn,
  job,
  jobEvent,
} from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { findBot } from "../../src/bot/conversation";
import { controlParts, textParts } from "../../src/bot/conversation/store";
import { handleRoutineWebhook, routineFireJobName, webhookTokenHash } from "../../src/bot/routines";
import { fireKey } from "../../src/bot/routines/routine";
import { checkInFireJobName, checkInKey } from "../../src/bot/routines/check-in";
import { approvedCallKey } from "../../src/bot/safety";
import { approvalExpiryKey } from "../../src/bot/safety/approval-expiry";
import { waitingIn } from "../../src/bot/triggers";
import { batchLongestMs } from "../../src/bot/triggers/router";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

// Sunday 18 October 2026, 10:00 UTC; the Routine runs every day at 08:00 UTC.
const sunday = new Date("2026-10-18T10:00:00.000Z");
const mondaySlot = new Date("2026-10-19T08:00:00.000Z");
const tuesdaySlot = new Date("2026-10-20T08:00:00.000Z");
const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const webhookToken = "wh_test_token_for_pause";

/**
 * A Bot of a new user, on an idle runner and a clock the test moves, with a past Turn, an active
 * scheduled Routine whose fire waits for Monday's slot, a paused one, an active webhook Routine and
 * a pending Check-in due on Monday at 09:00. `runDue()` runs every job due at the clock's time, one
 * after another, until none is left.
 */
async function pausableBot({ rounds = [] }: { rounds?: Parameters<typeof round>[] } = {}) {
  const timer = fakeJobClock(sunday);
  const fake = createFakeAdapter({ rounds: rounds.map((args) => round(...args)) });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({ jobs, adapterFor: () => fake.adapter, clock: timer.clock.now });
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  const db = getTestDb();
  const turnId = uuidv7();
  await db.insert(botTurn).values({
    id: turnId,
    botId,
    status: "complete",
    startedAt: new Date(sunday.getTime() - 60_000),
    endedAt: new Date(sunday.getTime() - 30_000),
  });
  const routine = (
    over: Partial<typeof botRoutine.$inferInsert>,
  ): typeof botRoutine.$inferInsert & { id: string } => ({
    id: uuidv7(),
    botId,
    name: "morning-brief",
    prompt: "Summarize.",
    schedule: { days: [...everyDay], at: "08:00" },
    timeZone: "UTC",
    state: "active" as const,
    createdByTurnId: turnId,
    approvedAt: sunday,
    createdAt: sunday,
    updatedAt: sunday,
    ...over,
  });
  const scheduled = routine({});
  const paused = routine({ name: "evening-brief", state: "paused" });
  const webhook = routine({
    name: "deploys",
    schedule: null,
    webhookTokenHash: webhookTokenHash(webhookToken),
  });
  await db.insert(botRoutine).values([scheduled, paused, webhook]);
  await deps.runner.enqueue(
    routineFireJobName,
    { routineId: scheduled.id, slot: mondaySlot.toISOString() },
    { idempotencyKey: fireKey(scheduled.id, mondaySlot), runAfter: mondaySlot },
  );
  const checkInId = uuidv7();
  const checkInAt = new Date("2026-10-19T09:00:00.000Z");
  await db.insert(botCheckIn).values({
    id: checkInId,
    botId,
    at: checkInAt,
    note: "Look at the build",
    state: "pending",
    createdByTurnId: turnId,
    createdAt: sunday,
    updatedAt: sunday,
  });
  await deps.runner.enqueue(
    checkInFireJobName,
    { checkInId },
    { idempotencyKey: checkInKey(checkInId), runAfter: checkInAt },
  );

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(db, timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const advanceTo = (when: Date) => timer.advance(when.getTime() - timer.clock.now().getTime());
  return {
    deps: deps,
    fake,
    user,
    client,
    botId,
    conversationId,
    turnId,
    routines: { scheduled: scheduled.id, paused: paused.id, webhook: webhook.id },
    checkInId,
    timer,
    runDue,
    advanceTo,
  };
}

const triggersOf = (conversationId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.conversationId, conversationId))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

const stateOf = async (routineId: string) =>
  (
    await getTestDb()
      .select({ state: botRoutine.state })
      .from(botRoutine)
      .where(eq(botRoutine.id, routineId))
  )[0]?.state;

/** When the Routine's queued fires are due. */
const queuedFires = async (routineId: string) =>
  (
    await getTestDb()
      .select({ runAfter: job.runAfter })
      .from(job)
      .where(
        and(
          like(job.idempotencyKey, `routine:${routineId}:%`),
          inArray(job.status, ["queued", "running"]),
        ),
      )
  ).map((row) => row.runAfter.toISOString());

/** A webhook call to the Routine with `token`, as its sender makes it. */
const callWebhook = (deps: TestDeps, token: string, body = '{"deploy":"ok"}') =>
  handleRoutineWebhook(
    deps,
    new Request(`https://app.example/routines/webhook/${token}`, { method: "POST", body }),
    token,
  );

describe("bots.pause", () => {
  it(
    "stops the Turn and the Helpers, skips the queue and what the stopped Turn never took with reason paused, and keeps each Routine's state",
    { timeout },
    async () => {
      const { client, botId, conversationId, turnId, routines } = await pausableBot();
      // The runner is idle, so the Turn this send starts stays running with its job queued.
      const hello = uuidv7();
      await client.bots.send({ botId, id: hello, text: "Hello" });
      const [running] = (await turnsOf(botId)).filter((turn) => turn.status === "running");
      expect(running).toBeDefined();
      const db = getTestDb();
      const helperId = uuidv7();
      await db.insert(botHelper).values({
        id: helperId,
        botId,
        type: "general",
        task: "Read the logs.",
        status: "running",
        startedByTurnId: turnId,
        startedAt: sunday,
      });
      const queued = `routine:${routines.scheduled}:2026-10-18T08:00:00.000Z`;
      await db.insert(botTrigger).values({
        id: queued,
        conversationId,
        source: "routine",
        channel: "schedule",
        text: 'Routine "morning-brief" ran.',
        receivedAt: sunday,
      });

      await client.bots.pause({ botId });

      expect((await turnsOf(botId)).find((turn) => turn.id === running!.id)?.status).toBe(
        "stopped",
      );
      const [helper] = await db.select().from(botHelper).where(eq(botHelper.id, helperId));
      expect(helper?.status).toBe("stopped");
      expect(await db.select().from(botTrigger).where(waitingIn(conversationId))).toEqual([]);
      const [skipped] = await db.select().from(botTrigger).where(eq(botTrigger.id, queued));
      expect(skipped).toMatchObject({ turnId: null, skipReason: "paused" });
      expect(skipped?.skippedAt).not.toBeNull();
      // The Turn the Message started never ran, so its Trigger is dropped too, not handed on.
      const [taken] = await db.select().from(botTrigger).where(eq(botTrigger.id, hello));
      expect(taken).toMatchObject({ turnId: null, skipReason: "paused" });
      expect(await stateOf(routines.scheduled)).toBe("active");
      expect(await stateOf(routines.paused)).toBe("paused");
      expect(await stateOf(routines.webhook)).toBe("active");
      expect((await client.bots.get({ botId })).bot.pausedAt).toEqual(sunday);
      const tasks = await client.bots.tasks({ botId });
      expect(tasks.inProgress.turn).toBeNull();
      expect(tasks.scheduled.triggers).toEqual([]);
      expect(tasks.done.skipped.map((trigger) => [trigger.id, trigger.skipReason]).sort()).toEqual(
        [
          [hello, "paused"],
          [queued, "paused"],
        ].sort(),
      );
    },
  );

  it(
    "while paused, a Routine slot, a Check-in and a webhook call make skipped Triggers and no Turn: the webhook answers 202, the Check-in ends fired, and the next slot stays queued",
    { timeout },
    async () => {
      const { deps, client, botId, conversationId, routines, checkInId, runDue, advanceTo } =
        await pausableBot();
      await client.bots.pause({ botId });
      const turnsBefore = await turnsOf(botId);

      advanceTo(mondaySlot);
      await runDue();
      advanceTo(new Date("2026-10-19T09:00:00.000Z"));
      await runDue();
      const response = await callWebhook(deps, webhookToken);

      expect(response.status).toBe(202);
      expect(await turnsOf(botId)).toEqual(turnsBefore);
      const triggers = await triggersOf(conversationId);
      expect(triggers.map((row) => [row.source, row.channel, row.turnId, row.skipReason])).toEqual([
        ["routine", "schedule", null, "paused"],
        ["check_in", "schedule", null, "paused"],
        ["routine", "webhook", null, "paused"],
      ]);
      expect(triggers[0]?.id).toBe(fireKey(routines.scheduled, mondaySlot));
      const [checkIn] = await getTestDb()
        .select()
        .from(botCheckIn)
        .where(eq(botCheckIn.id, checkInId));
      expect(checkIn?.state).toBe("fired");
      expect(await queuedFires(routines.scheduled)).toEqual([tuesdaySlot.toISOString()]);
      const tasks = await client.bots.tasks({ botId });
      expect(tasks.done.skipped.map((trigger) => [trigger.source, trigger.label])).toEqual([
        ["routine", "deploys"],
        ["check_in", "Look at the build"],
        ["routine", "morning-brief"],
      ]);
      // The skipped Check-in fire shows once, under skipped.
      expect(tasks.done.checkIns).toEqual([]);
    },
  );

  it(
    "refuses a user Message, a choice's answer and an open Approval's yes while paused, and changes none of them; a closed Approval answers as closed",
    { timeout },
    async () => {
      const { client, botId, conversationId, turnId } = await pausableBot();
      const reviewId = uuidv7();
      const expiresAt = new Date(sunday.getTime() + 7 * 24 * 60 * 60_000);
      await getTestDb()
        .insert(botReview)
        .values({
          id: reviewId,
          botId,
          turnId,
          toolCallId: uuidv7(),
          tool: "shell",
          input: { command: "git push" },
          summary: "Pushes to GitHub",
          verdict: "block",
          reason: "The user never asked to push",
          state: "pending",
          expiresAt,
          createdAt: sunday,
        });
      const closedId = uuidv7();
      await getTestDb()
        .insert(botReview)
        .values({
          id: closedId,
          botId,
          turnId,
          toolCallId: uuidv7(),
          tool: "shell",
          input: { command: "rm -rf build" },
          summary: "Deletes the build",
          verdict: "block",
          reason: "Destructive",
          state: "expired",
          createdAt: sunday,
        });
      const choice = { kind: "choice" as const, options: ["Red", "Blue"], other: false };
      const asked = await getTestDb().transaction((tx) =>
        appendMessage(tx, conversationId, {
          role: "assistant",
          parts: controlParts("Which color?", choice),
          status: "complete",
          createdAt: sunday,
        }),
      );
      await client.bots.pause({ botId });

      await expect(
        client.bots.send({ botId, id: uuidv7(), text: "Are you there?" }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.botPaused" } });
      await expect(client.reviews.allow({ reviewId })).rejects.toMatchObject({
        code: "CONFLICT",
        data: { code: "error.botPausedApproval" },
      });
      await expect(
        client.bots.choose({ botId, messageId: asked.id, answer: { option: "Red" } }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.botPaused" } });
      await expect(client.reviews.allow({ reviewId: closedId })).resolves.toEqual({
        decided: false,
        state: "expired",
      });

      const { messages } = await client.bots.get({ botId });
      expect(messages.map((shown) => [shown.id, shown.control])).toEqual([[asked.id, choice]]);
      expect(await triggersOf(conversationId)).toEqual([]);
      const [review] = await getTestDb().select().from(botReview).where(eq(botReview.id, reviewId));
      expect(review).toMatchObject({ state: "pending", expiresAt });
    },
  );

  it(
    "cancels an allowed call that hasn't started and leaves its Approval pending, to answer again after resume",
    { timeout },
    async () => {
      const { client, botId, conversationId, turnId, runDue } = await pausableBot();
      const db = getTestDb();
      const reviewId = uuidv7();
      const expiresAt = new Date(sunday.getTime() + 7 * 24 * 60 * 60_000);
      await db.insert(botReview).values({
        id: reviewId,
        botId,
        turnId,
        toolCallId: uuidv7(),
        tool: "shell",
        input: { command: "git push" },
        summary: "Pushes to GitHub",
        verdict: "block",
        reason: "The user never asked to push",
        state: "pending",
        expiresAt,
        createdAt: sunday,
      });
      // Their statuses, in name order: both jobs are made at the same clock time.
      const callJobs = async () =>
        (
          await db
            .select({ status: job.status })
            .from(job)
            .where(eq(job.idempotencyKey, approvedCallKey(reviewId)))
        ).sort((a, b) => a.status.localeCompare(b.status));
      // The yes queues the call; the pause comes before it starts.
      await client.reviews.allow({ reviewId });
      expect(await callJobs()).toEqual([{ status: "queued" }]);

      await client.bots.pause({ botId });
      await runDue();

      expect(await callJobs()).toEqual([{ status: "cancelled" }]);
      const [review] = await db.select().from(botReview).where(eq(botReview.id, reviewId));
      expect(review).toMatchObject({ state: "pending", expiresAt, decidedAt: null });
      expect(await triggersOf(conversationId)).toEqual([]);
      // Its expiry is queued, so it still expires after 7 days.
      expect(
        await db
          .select({ status: job.status, runAfter: job.runAfter })
          .from(job)
          .where(eq(job.idempotencyKey, approvalExpiryKey(reviewId))),
      ).toEqual([{ status: "queued", runAfter: expiresAt }]);

      await client.bots.resume({ botId });
      await expect(client.reviews.allow({ reviewId })).resolves.toEqual({
        decided: true,
        state: "allowed",
      });
      expect(await callJobs()).toEqual([{ status: "cancelled" }, { status: "queued" }]);
    },
  );

  it(
    "cancels an allowed call waiting out a retry before it started, and leaves one past its start marker",
    { timeout },
    async () => {
      const { client, botId, turnId, runDue } = await pausableBot();
      const db = getTestDb();
      const allowed = async (startedCall: boolean) => {
        const reviewId = uuidv7();
        await db.insert(botReview).values({
          id: reviewId,
          botId,
          turnId,
          toolCallId: uuidv7(),
          tool: "shell",
          input: { command: "git push" },
          summary: "Pushes to GitHub",
          verdict: "block",
          reason: "The user never asked to push",
          state: "pending",
          expiresAt: new Date(sunday.getTime() + 7 * 24 * 60 * 60_000),
          createdAt: sunday,
        });
        await client.reviews.allow({ reviewId });
        // Its first attempt failed and it waits out the backoff, queued again.
        const [row] = await db
          .update(job)
          .set({ attempts: 1, runAfter: new Date(sunday.getTime() + 60 * 60_000) })
          .where(eq(job.idempotencyKey, approvedCallKey(reviewId)))
          .returning({ id: job.id });
        await db
          .insert(jobEvent)
          .values([
            { jobId: row!.id, seq: 1, kind: "activity", name: "quota", result: false },
            ...(startedCall
              ? [{ jobId: row!.id, seq: 2, kind: "activity" as const, name: "call_start" }]
              : []),
          ]);
        return reviewId;
      };
      const unstarted = await allowed(false);
      const started = await allowed(true);

      await client.bots.pause({ botId });
      await runDue();

      const statusOf = async (reviewId: string) => {
        const [review] = await db.select().from(botReview).where(eq(botReview.id, reviewId));
        const [call] = await db
          .select({ status: job.status })
          .from(job)
          .where(eq(job.idempotencyKey, approvedCallKey(reviewId)));
        return [review!.state, call!.status];
      };
      expect(await statusOf(unstarted)).toEqual(["pending", "cancelled"]);
      expect(await statusOf(started)).toEqual(["allowed", "queued"]);
    },
  );

  it(
    "resume replays nothing, and the next slot runs; the next Turn never sees a user Message the pause skipped",
    { timeout },
    async () => {
      const { client, fake, botId, conversationId, routines, timer, runDue, advanceTo } =
        await pausableBot({ rounds: [[], []] });
      // A user Message waiting in the queue when the pause comes.
      const skippedId = uuidv7();
      await getTestDb().transaction(async (tx) => {
        await appendMessage(tx, conversationId, {
          id: skippedId,
          role: "user",
          parts: textParts("Book the flight"),
          status: "complete",
          createdAt: sunday,
        });
        await tx.insert(botTrigger).values({
          id: skippedId,
          conversationId,
          source: "user",
          channel: "web",
          messageId: skippedId,
          receivedAt: sunday,
        });
        // An emailed one, whose Trigger id isn't its Message's.
        const emailed = await appendMessage(tx, conversationId, {
          role: "user",
          parts: { ...textParts("Cancel the hotel"), channel: "email", subject: "Hotel" },
          status: "complete",
          createdAt: sunday,
        });
        await tx.insert(botTrigger).values({
          id: "email:hotel@mail.example",
          conversationId,
          source: "user",
          channel: "email",
          messageId: emailed.id,
          receivedAt: sunday,
        });
      });
      await client.bots.pause({ botId });
      advanceTo(mondaySlot);
      await runDue();
      const turnsWhilePaused = await turnsOf(botId);

      await client.bots.resume({ botId });
      await runDue();

      expect((await client.bots.get({ botId })).bot.pausedAt).toBeNull();
      expect(await turnsOf(botId)).toEqual(turnsWhilePaused);
      expect(await getTestDb().select().from(botTrigger).where(waitingIn(conversationId))).toEqual(
        [],
      );

      advanceTo(tuesdaySlot);
      await runDue();
      // The Turn's job runs once its batch closes.
      timer.advance(batchLongestMs);
      await runDue();

      const tuesday = (await triggersOf(conversationId)).find(
        (row) => row.id === fireKey(routines.scheduled, tuesdaySlot),
      );
      expect(tuesday?.skippedAt).toBeNull();
      expect(tuesday?.turnId).not.toBeNull();
      const [turn] = (await turnsOf(botId)).filter((row) => row.id === tuesday?.turnId);
      expect(turn?.status).toBe("complete");
      const calls = fake.calls.filter(isTurnCall);
      expect(calls).toHaveLength(1);
      const input = JSON.stringify(calls[0]!.messages);
      expect(input).toContain("morning-brief");
      expect(input).not.toContain("Book the flight");
      expect(input).not.toContain("Cancel the hotel");
    },
  );

  it(
    "touches only the one Bot: the user's other Bot keeps running, and another user's Bot is not found",
    { timeout },
    async () => {
      const { deps, client, botId } = await pausableBot();
      const { id: otherId } = await client.bots.create({ name: "Grace", model });

      await client.bots.pause({ botId });

      expect((await client.bots.get({ botId: otherId })).bot.pausedAt).toBeNull();
      const sent = await client.bots.send({ botId: otherId, id: uuidv7(), text: "Hi" });
      expect(sent.text).toBe("Hi");
      const stranger = chatRpc({ user: await insertUser(), deps });
      for (const call of [stranger.bots.pause, stranger.bots.resume]) {
        await expect(call({ botId })).rejects.toMatchObject({
          code: "NOT_FOUND",
          data: { code: "error.botNotFound" },
        });
      }
      expect((await client.bots.get({ botId })).bot.pausedAt).not.toBeNull();
    },
  );

  it(
    "is idempotent both ways, and hints the Conversation with a bot change only when it changes",
    { timeout },
    async () => {
      const { deps, client, botId, conversationId, timer } = await pausableBot();
      const events: string[] = [];
      await deps.pubsub.subscribe(conversationChannel(conversationId), (message) => {
        events.push(message);
      });

      await client.bots.pause({ botId });
      timer.advance(60_000);
      await client.bots.pause({ botId });

      expect((await client.bots.get({ botId })).bot.pausedAt).toEqual(sunday);
      await expect.poll(() => events.length, { timeout: 10_000 }).toBe(1);

      await client.bots.resume({ botId });
      await client.bots.resume({ botId });

      await expect.poll(() => events.length, { timeout: 10_000 }).toBe(2);
      const log = await client.conversations.changes({ conversationId, since: 0 });
      if (log.reload) throw new Error("reload");
      const bots = log.changes.filter((change) => change.kind === "bot");
      expect(bots.map((change) => change.refId)).toEqual([botId, botId]);
      expect(bots.at(-1)?.data).toMatchObject({ id: botId, pausedAt: null });
    },
  );
});
