import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botTrigger, botTurn, computer, job } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { findBot } from "../../src/bot/conversation";
import { saveCredentials } from "../../src/models/internal";
import { createJobRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { manualExecutor } from "@ai-chat/test-support/executors";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

/*
 * The Bots and the Computer on an Executor that isn't in-process (spec #872): the Executor runs a
 * job only when the test calls `run`, and the outcomes are the in-process ones.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const minuteMs = 60_000;
// Sunday 18 October 2026, 11:00 in London (summer time).
const sunday = new Date("2026-10-18T10:00:00.000Z");
const mondaySlot = "2026-10-19T07:00:00.000Z";

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A started runner on a manual Executor and a clock the test moves, and a Bot with a Computer. */
async function setup(rounds: Parameters<typeof createFakeAdapter>[0]["rounds"] = []) {
  const timer = fakeJobClock(sunday);
  const manual = manualExecutor();
  const fake = createFakeAdapter({ rounds });
  const provider = fakeComputerProvider();
  const jobs = createJobRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    executor: manual.executor,
    jobs: () => deps.parts.jobs,
  });
  const deps = createTestSdk({
    jobs,
    computer: provider.provider,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
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
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;

  /** Runs every queued job named `name` that is due now, as the Executor would be told to. */
  const runQueued = async (name: string) => {
    const queued = await getTestDb()
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.name, name), eq(job.status, "queued")))
      .orderBy(asc(job.runAfter));
    for (const { id } of queued) await manual.run(id);
    return queued.length;
  };
  /** Sends `text`, reads only the saved Message, and leaves the stream. */
  const sendSaved = async (text: string) => {
    const leave = new AbortController();
    try {
      const stream = await followSend(
        client,
        { botId, id: uuidv7(), text, timeZone: "Europe/London" },
        { signal: leave.signal },
      );
      await stream.next();
    } finally {
      leave.abort();
    }
  };
  return {
    timer,
    manual,
    fake,
    provider,
    deps,
    user,
    client,
    botId,
    conversationId,
    runQueued,
    sendSaved,
  };
}

const turnsOf = (botId: string) =>
  getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));

describe("the Bots and the Computer on a manual Executor", () => {
  it(
    "runs a Turn when the Executor runs its job, and sends its Messages once",
    { timeout: 30_000 },
    async () => {
      const { client, botId, manual, timer, runQueued, sendSaved } = await setup([
        round(toolCall({ name: "send_to_user", input: { text: "Hello!", endTurn: true } })),
        round(),
      ]);

      await sendSaved("Hi");

      expect(manual.notified).toHaveLength(1);
      expect((await turnsOf(botId)).map((turn) => turn.status)).toEqual(["running"]);
      // The Turn job is due a moment after the send (the Router debounces).
      timer.advance(500);
      expect(await runQueued("bot.turn")).toBe(1);
      await expect
        .poll(async () => (await turnsOf(botId)).map((turn) => turn.status), { timeout: 10_000 })
        .toEqual(["complete"]);
      const { messages } = await client.bots.get({ botId });
      expect(messages.map((sent) => [sent.role, sent.text])).toEqual([
        ["user", "Hi"],
        ["assistant", "Hello!"],
      ]);
    },
  );

  it("fires a Routine at its slot and queues the next fire", { timeout: 30_000 }, async () => {
    const { client, botId, conversationId, manual, timer, runQueued, sendSaved } = await setup([
      round(
        toolCall({
          name: "create_routine",
          input: {
            name: "morning-brief",
            prompt: "Summarize today's calendar.",
            schedule: { days: ["mon", "tue", "wed", "thu", "fri"], times: ["08:00"] },
          },
        }),
      ),
      round(),
      round(),
    ]);
    await sendSaved("Set it up, please");
    timer.advance(500);
    expect(await runQueued("bot.turn")).toBe(1);
    await expect
      .poll(async () => (await turnsOf(botId)).map((turn) => turn.status), { timeout: 10_000 })
      .toEqual(["complete"]);
    const [listed] = await client.routines.list({ botId });
    await client.routines.approve({ routineId: listed!.id });
    expect(manual.notified.at(-1)?.runAfter).toEqual(new Date(mondaySlot));

    timer.advance(new Date(mondaySlot).getTime() - timer.clock.now().getTime());
    expect(await runQueued("bot.routine_fire")).toBe(1);

    const triggers = await getTestDb()
      .select()
      .from(botTrigger)
      .where(and(eq(botTrigger.conversationId, conversationId), eq(botTrigger.source, "routine")));
    expect(triggers.map((trigger) => trigger.id)).toEqual([`routine:${listed!.id}:${mondaySlot}`]);
    const nextFire = await getTestDb()
      .select({ runAfter: job.runAfter })
      .from(job)
      .where(and(eq(job.name, "bot.routine_fire"), eq(job.status, "queued")));
    expect(nextFire.map((row) => row.runAfter.toISOString())).toEqual(["2026-10-20T07:00:00.000Z"]);
    expect(manual.notified.map((notice) => notice.runAfter)).toContainEqual(
      new Date("2026-10-20T07:00:00.000Z"),
    );
  });

  it(
    "pauses an idle Computer when the Executor runs its sleep check",
    { timeout: 30_000 },
    async () => {
      const { user, deps, manual, provider, timer, runQueued } = await setup();

      await deps.computer!.forUser(user.id).run("true");
      expect(manual.notified.at(-1)?.runAfter).toEqual(new Date(sunday.getTime() + 5 * minuteMs));
      timer.advance(5 * minuteMs + 1);
      expect(await runQueued("computer.sleep")).toBe(1);

      expect(provider.callsOf("pause")).toHaveLength(1);
      const [row] = await getTestDb().select().from(computer).where(eq(computer.userId, user.id));
      expect(row?.state).toBe("asleep");
    },
  );
});
