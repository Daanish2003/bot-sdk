import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { appendMessage } from "../../src/chat/message-tree";
import {
  bot,
  botCheckIn,
  botHelper,
  botHelperScreenshot,
  botReview,
  botRoutine,
  botTrigger,
  botTurn,
  customRule,
  job,
  message,
} from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { findBot } from "../../src/bot/conversation";
import { controlParts } from "../../src/bot/conversation/store";
import { storeScreenshot } from "../../src/bot/conversation/screenshots";
import { handleRoutineWebhook, routineFireJobName, webhookTokenHash } from "../../src/bot/routines";
import { fireKey } from "../../src/bot/routines/routine";
import { checkInFireJobName, checkInKey } from "../../src/bot/routines/check-in";
import { approvedCallJobName, approvedCallKey } from "../../src/bot/safety";
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
const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * A user with two Bots, Ada and Grace, on an idle runner and a clock the test moves. Each Bot has a
 * past Turn, an active scheduled Routine whose fire waits for Monday's slot, a webhook Routine and a
 * pending Check-in with its fire queued. `runDue()` runs every job due at the clock's time.
 */
async function resettableBots({ rounds = [] }: { rounds?: Parameters<typeof round>[] } = {}) {
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
  const db = getTestDb();

  const furnish = async (name: string) => {
    const { id: botId } = await client.bots.create({ name, model });
    const { conversationId } = (await findBot(db, user.id, botId))!;
    const turnId = uuidv7();
    await db.insert(botTurn).values({
      id: turnId,
      botId,
      status: "complete",
      startedAt: new Date(sunday.getTime() - 60_000),
      endedAt: new Date(sunday.getTime() - 30_000),
    });
    const token = `wh_reset_${name}_${uuidv7()}`;
    const routine = (over: Partial<typeof botRoutine.$inferInsert>) => ({
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
    const webhook = routine({
      name: "deploys",
      schedule: null,
      webhookTokenHash: webhookTokenHash(token),
    });
    await db.insert(botRoutine).values([scheduled, webhook]);
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
    return {
      botId,
      conversationId,
      turnId,
      token,
      routines: { scheduled: scheduled.id, webhook: webhook.id },
      checkInId,
    };
  };
  const ada = await furnish("Ada");
  const grace = await furnish("Grace");

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(db, timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  return { deps, fake, user, client, ada, grace, timer, runDue };
}

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

/** The queued or running fire jobs of the Routines and Check-ins `ids`. */
const queuedFires = async (ids: { routines: string[]; checkIns: string[] }) =>
  (
    await getTestDb()
      .select({ key: job.idempotencyKey })
      .from(job)
      .where(
        and(
          or(
            ...ids.routines.map((id) => like(job.idempotencyKey, `routine:${id}:%`)),
            ...ids.checkIns.map((id) => eq(job.idempotencyKey, checkInKey(id))),
          ),
          inArray(job.status, ["queued", "running"]),
        ),
      )
  ).map((row) => row.key);

/** A webhook call with `token`, as its sender makes it. */
const callWebhook = (deps: TestDeps, token: string) =>
  handleRoutineWebhook(
    deps,
    new Request(`https://app.example/routines/webhook/${token}`, {
      method: "POST",
      body: '{"deploy":"ok"}',
    }),
    token,
  );

describe("bots.reset", () => {
  it(
    "stops the Turn, skips the queue with reason reset, declines pending Approvals, deletes the Routines, Check-ins and Helpers, and appends the reset mark; the rest stays",
    { timeout },
    async () => {
      const { deps, user, client, ada, grace } = await resettableBots();
      const db = getTestDb();
      // The runner is idle, so the Turn this send starts stays running with its job queued.
      const hello = uuidv7();
      await client.bots.send({ botId: ada.botId, id: hello, text: "Hello" });
      const [running] = (await turnsOf(ada.botId)).filter((turn) => turn.status === "running");
      expect(running).toBeDefined();
      const helper = (status: "running" | "complete") => ({
        id: uuidv7(),
        botId: ada.botId,
        type: "general" as const,
        task: "Read the logs.",
        status,
        startedByTurnId: ada.turnId,
        startedAt: sunday,
        transcript: status === "complete" ? [{ role: "user" as const, content: "Read." }] : null,
      });
      const live = helper("running");
      const ended = helper("complete");
      await db.insert(botHelper).values([live, ended]);
      const screenshotId = await storeScreenshot(deps, ended.id, new Uint8Array([1, 2, 3]));
      const queued = `routine:${ada.routines.scheduled}:2026-10-18T08:00:00.000Z`;
      await db.insert(botTrigger).values({
        id: queued,
        conversationId: ada.conversationId,
        source: "routine",
        channel: "schedule",
        text: 'Routine "morning-brief" ran.',
        receivedAt: sunday,
      });
      const review = (state: "pending" | "allowed") => ({
        id: uuidv7(),
        botId: ada.botId,
        turnId: ada.turnId,
        toolCallId: uuidv7(),
        tool: "shell",
        input: { command: "git push" },
        summary: "Pushes to GitHub",
        verdict: "block" as const,
        reason: "The user never asked to push",
        state,
        expiresAt: new Date(sunday.getTime() + 7 * 24 * 60 * 60_000),
        decidedAt: state === "allowed" ? sunday : null,
        createdAt: sunday,
      });
      const pending = review("pending");
      const allowed = review("allowed");
      await db.insert(botReview).values([pending, allowed]);
      // A late yes queued the allowed call; it hasn't run.
      await deps.runner.enqueue(
        approvedCallJobName,
        { reviewId: allowed.id },
        { idempotencyKey: approvedCallKey(allowed.id) },
      );
      const ruleId = uuidv7();
      await db.insert(customRule).values({
        id: ruleId,
        userId: user.id,
        text: "Never push on Fridays",
        mode: "ask",
        state: "active",
        proposedByBotId: ada.botId,
        createdAt: sunday,
        updatedAt: sunday,
      });
      const before = await client.bots.get({ botId: ada.botId });

      await client.bots.reset({ botId: ada.botId, name: "Ada" });

      // Stopped as a pause stops it, with reason reset.
      expect((await turnsOf(ada.botId)).find((turn) => turn.id === running!.id)?.status).toBe(
        "stopped",
      );
      expect(await db.select().from(botTrigger).where(waitingIn(ada.conversationId))).toEqual([]);
      const skipped = await db
        .select({ id: botTrigger.id, turnId: botTrigger.turnId, reason: botTrigger.skipReason })
        .from(botTrigger)
        .where(eq(botTrigger.conversationId, ada.conversationId));
      expect(skipped.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [
          { id: hello, turnId: null, reason: "reset" },
          { id: queued, turnId: null, reason: "reset" },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      // The pending Approval is declined; a decided one stays as it was.
      const reviews = await db
        .select({ id: botReview.id, state: botReview.state })
        .from(botReview)
        .where(eq(botReview.botId, ada.botId));
      expect(new Map(reviews.map((row) => [row.id, row.state]))).toEqual(
        new Map([
          [pending.id, "denied"],
          [allowed.id, "allowed"],
        ]),
      );
      // Its queued call is cancelled, so it never runs.
      expect(
        await db
          .select({ status: job.status })
          .from(job)
          .where(eq(job.idempotencyKey, approvedCallKey(allowed.id))),
      ).toEqual([{ status: "cancelled" }]);
      // Its Routines, Check-ins and Helpers are gone, with their queued fires and screenshots.
      expect(await db.select().from(botRoutine).where(eq(botRoutine.botId, ada.botId))).toEqual([]);
      expect(await db.select().from(botCheckIn).where(eq(botCheckIn.botId, ada.botId))).toEqual([]);
      expect(await db.select().from(botHelper).where(eq(botHelper.botId, ada.botId))).toEqual([]);
      expect(
        await db.select().from(botHelperScreenshot).where(eq(botHelperScreenshot.id, screenshotId)),
      ).toEqual([]);
      await expect
        .poll(() => deps.blobStore.get(`screenshot/${screenshotId}`), { timeout: 10_000 })
        .toBeNull();
      expect(
        await queuedFires({
          routines: Object.values(ada.routines),
          checkIns: [ada.checkInId],
        }),
      ).toEqual([]);
      expect((await callWebhook(deps, ada.token)).status).toBe(404);
      // No Message or Turn goes; the reset mark is the Conversation's last Message.
      const after = await client.bots.get({ botId: ada.botId });
      expect(after.messages.slice(0, -1)).toEqual(before.messages);
      expect(after.messages.at(-1)).toMatchObject({ role: "reset", createdAt: sunday });
      expect((await turnsOf(ada.botId)).map((turn) => turn.id).sort()).toEqual(
        [ada.turnId, running!.id].sort(),
      );
      // Its name, model and pause state, and the Custom Rule it proposed, stay.
      expect(after.bot).toMatchObject({ name: "Ada", model, pausedAt: null });
      expect(await db.select().from(customRule).where(eq(customRule.id, ruleId))).toHaveLength(1);
      const tasks = await client.bots.tasks({ botId: ada.botId });
      expect(tasks.inProgress.turn).toBeNull();
      expect(tasks.scheduled.triggers).toEqual([]);
      expect(tasks.scheduled.routines).toEqual([]);
      expect(tasks.scheduled.checkIns).toEqual([]);
      // The user's other Bot keeps everything.
      expect(
        await db.select().from(botRoutine).where(eq(botRoutine.botId, grace.botId)),
      ).toHaveLength(2);
      expect(
        await db.select().from(botCheckIn).where(eq(botCheckIn.botId, grace.botId)),
      ).toHaveLength(1);
      expect(
        await queuedFires({
          routines: Object.values(grace.routines),
          checkIns: [grace.checkInId],
        }),
      ).toHaveLength(2);
      expect((await callWebhook(deps, grace.token)).status).toBe(202);
    },
  );

  it(
    "refuses a wrong name and changes nothing; another user's Bot is not found",
    { timeout },
    async () => {
      const { deps, client, ada } = await resettableBots();
      const before = await client.bots.get({ botId: ada.botId });

      for (const name of ["ada", "Grace", ""]) {
        await expect(client.bots.reset({ botId: ada.botId, name })).rejects.toMatchObject({
          code: "BAD_REQUEST",
          data: { code: "error.botResetName" },
        });
      }
      const stranger = chatRpc({ user: await insertUser(), deps });
      await expect(stranger.bots.reset({ botId: ada.botId, name: "Ada" })).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { code: "error.botNotFound" },
      });

      expect(await client.bots.get({ botId: ada.botId })).toEqual(before);
      expect(
        await getTestDb().select().from(botRoutine).where(eq(botRoutine.botId, ada.botId)),
      ).toHaveLength(2);
    },
  );

  it(
    "refuses an answer to a choice asked before the reset, and queues nothing",
    { timeout },
    async () => {
      const { client, ada, timer } = await resettableBots();
      const db = getTestDb();
      const choice = { kind: "choice" as const, options: ["Red", "Blue"], other: false };
      const asked = await db.transaction((tx) =>
        appendMessage(tx, ada.conversationId, {
          role: "assistant",
          parts: controlParts("Which color?", choice),
          status: "complete",
          createdAt: sunday,
        }),
      );
      timer.advance(60_000);
      await client.bots.reset({ botId: ada.botId, name: "Ada" });

      await expect(
        client.bots.choose({ botId: ada.botId, messageId: asked.id, answer: { option: "Red" } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", data: { code: "error.messageNotFound" } });
      expect(
        await db.select().from(botTrigger).where(eq(botTrigger.conversationId, ada.conversationId)),
      ).toEqual([]);
    },
  );

  it("keeps a paused Bot paused", { timeout }, async () => {
    const { client, ada } = await resettableBots();
    await client.bots.pause({ botId: ada.botId });

    await client.bots.reset({ botId: ada.botId, name: "Ada" });

    const after = await client.bots.get({ botId: ada.botId });
    expect(after.bot.pausedAt).toEqual(sunday);
    expect(after.messages.at(-1)?.role).toBe("reset");
  });

  it(
    "starts the next Turn's history after the reset mark: the Model is told nothing from before",
    { timeout },
    async () => {
      const { client, fake, ada, timer, runDue } = await resettableBots({ rounds: [[], []] });
      await client.bots.send({ botId: ada.botId, id: uuidv7(), text: "The code is 4417" });
      timer.advance(batchLongestMs);
      await runDue();
      expect(fake.calls.filter(isTurnCall)).toHaveLength(1);

      timer.advance(60_000);
      await client.bots.reset({ botId: ada.botId, name: "Ada" });
      timer.advance(60_000);
      await client.bots.send({ botId: ada.botId, id: uuidv7(), text: "Hello again" });
      timer.advance(batchLongestMs);
      await runDue();

      const calls = fake.calls.filter(isTurnCall);
      expect(calls).toHaveLength(2);
      const told = JSON.stringify([calls[1]!.systemPrompts, calls[1]!.messages]);
      expect(told).toContain("Hello again");
      expect(told).not.toContain("4417");
      // The user still sees the old Messages.
      const { messages } = await client.bots.get({ botId: ada.botId });
      expect(messages.map((shown) => [shown.role, shown.text])).toEqual([
        ["user", "The code is 4417"],
        ["reset", ""],
        ["user", "Hello again"],
      ]);
    },
  );

  it("records each change and hints the Conversation once", { timeout }, async () => {
    const { deps, client, ada } = await resettableBots();
    const events: string[] = [];
    await deps.pubsub.subscribe(conversationChannel(ada.conversationId), (event) => {
      events.push(event);
    });

    await client.bots.reset({ botId: ada.botId, name: "Ada" });

    await expect.poll(() => events.length, { timeout: 10_000 }).toBe(1);
    const log = await client.conversations.changes({
      conversationId: ada.conversationId,
      since: 0,
    });
    if (log.reload) throw new Error("reload");
    const kinds = log.changes.map((change) => change.kind);
    expect(kinds).toEqual(expect.arrayContaining(["routine", "check_in", "message", "bot"]));
    expect(log.changes.filter((change) => change.kind === "routine").map((c) => c.data)).toEqual([
      null,
      null,
    ]);
    const [mark] = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.conversationId, ada.conversationId), eq(message.role, "reset")));
    expect(log.changes.find((change) => change.kind === "message")?.refId).toBe(mark?.id);
    // The Bot itself is unchanged.
    const [row] = await getTestDb().select().from(bot).where(eq(bot.id, ada.botId));
    expect(row?.name).toBe("Ada");
  });
});
