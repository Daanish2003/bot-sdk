import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botRoutine, botTrigger, botTurn, job, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { bot } from "../../../../plugins/bot/server/plugin";
import { routineFireJobName } from "../../../../plugins/bot/server/routine";
import { findBot } from "../../../../plugins/bot/server/store";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const hostModel = "anthropic:claude-sonnet-5-5";
const planModel = "openai:gpt-6-luna";
const planCredentials = { apiKey: "chatgpt-access-token" };
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];

const createRoutine = (input: unknown) => toolCall({ name: "create_routine", input });
const sends = (input: { text: string; endTurn: boolean }) =>
  toolCall({ name: "send_to_user", input });

type RoutineInput = {
  name: string;
  prompt: string;
  schedule: { days: string[]; at: string };
};

const weekdays = ["mon", "tue", "wed", "thu", "fri"];
const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const morningBrief: RoutineInput = {
  name: "morning-brief",
  prompt: "Summarize today's calendar.",
  schedule: { days: weekdays, at: "08:00" },
};

/**
 * A Bot whose Routine `routine` the user has approved, on an idle runner and a clock the test
 * moves: the Bot created it at `at`, in `timeZone`, and the user approved it right away. `runDue()`
 * runs every job due at the clock's time, one after another, until none is left. The Model plays
 * `rounds` after the two that create the Routine.
 */
async function approvedRoutine({
  at,
  routine = morningBrief,
  timeZone = "Europe/London",
  rounds = [],
  manual = false,
  host = false,
  linked = false,
  getQuota,
  isUserBlocked,
}: {
  at: Date;
  routine?: RoutineInput;
  timeZone?: string;
  rounds?: Round[];
  manual?: boolean;
  host?: boolean;
  /** The Bot is on a ChatGPT plan Model and the user has a linked plan, not a key (ADR 0023). */
  linked?: boolean;
} & Pick<TestDepsOverrides, "getQuota" | "isUserBlocked">) {
  const timer = fakeJobClock(at);
  const creation = [round(createRoutine(routine)), round()];
  const fake = createFakeAdapter({ rounds: [...creation, ...rounds], manual });
  let deps: TestDeps | undefined;
  const adapterCredentials: Array<Record<string, string>> = [];
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot()],
    jobs,
    adapterFor: (_model, credentials) => {
      adapterCredentials.push(credentials);
      return fake.adapter;
    },
    clock: timer.clock.now,
    ...(host && { hostProviders }),
    ...(linked && { linkedCredentials: async () => planCredentials }),
    getQuota,
    isUserBlocked,
  });
  started.push(jobs);
  const user = await insertUser();
  if (!host && !linked) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({
    name: "Ada",
    model: host ? hostModel : linked ? planModel : model,
  });
  const botId = created.id;
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const advanceTo = (when: string | Date) => {
    timer.advance(new Date(when).getTime() - timer.clock.now().getTime());
  };
  const sendSaved = async (text: string) => {
    const stream = await client.bot.send({ botId, id: uuidv7(), text, timeZone });
    await stream.next();
    await stream.return(undefined);
  };

  if (manual) void fake.release(creation.flat().length);
  await sendSaved("Set it up, please");
  timer.advance(500);
  await runDue();
  const [listed] = await client.bot.routine.list({ botId });
  await client.bot.routine.approve({ routineId: listed!.id });

  return {
    fake,
    adapterCredentials,
    deps,
    client,
    user,
    botId,
    conversationId,
    routineId: listed!.id,
    timer,
    runDue,
    advanceTo,
    sendSaved,
  };
}

/** The Conversation's Triggers from Routines, in the order they were received. */
const routineTriggers = (conversationId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(and(eq(botTrigger.conversationId, conversationId), eq(botTrigger.source, "routine")))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));

/** When the Routine's queued fires are due. */
const queuedFires = async (routineId: string) =>
  (
    await getTestDb()
      .select({ runAfter: job.runAfter, key: job.idempotencyKey })
      .from(job)
      .where(
        and(
          like(job.idempotencyKey, `routine:${routineId}:%`),
          inArray(job.status, ["queued", "running"]),
        ),
      )
  ).map((row) => row.runAfter.toISOString());

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

/** A model call's messages after the Prompt start's first message. */
const inputOf = (call: TextOptions | undefined) =>
  ((call?.messages ?? []) as ModelMessage[]).slice(1);

// Sunday 18 October 2026, 11:00 in London (summer time, UTC+1).
const sunday = new Date("2026-10-18T10:00:00.000Z");
// Monday 19 October, 08:00 in London.
const mondaySlot = "2026-10-19T07:00:00.000Z";

const wakeNotice =
  `Routine "morning-brief" ran at Mon 2026-10-19 08:00 (Europe/London). The user didn't send ` +
  `this; it's their approved Routine. Message the user only if this run finds something new. If ` +
  `it finds nothing new, send nothing at all, not even a message saying nothing changed.`;

describe("a scheduled Routine", () => {
  it("queues its first fire when approved, and past Monday 08:00 London makes one routine / schedule Trigger with the prompt snapshot, then queues Tuesday's", async () => {
    const { client, botId, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    expect(await queuedFires(routineId)).toEqual([mondaySlot]);
    // The approved divider shows it.
    expect((await client.bot.routine.list({ botId }))[0]?.nextRunAt).toEqual(new Date(mondaySlot));

    advanceTo("2026-10-19T06:59:59.000Z");
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([]);

    advanceTo(mondaySlot);
    await runDue();

    expect(await routineTriggers(conversationId)).toEqual([
      expect.objectContaining({
        id: `routine:${routineId}:${mondaySlot}`,
        source: "routine",
        channel: "schedule",
        messageId: null,
        text: `${wakeNotice}\n\n${morningBrief.prompt}`,
      }),
    ]);
    expect(await queuedFires(routineId)).toEqual(["2026-10-20T07:00:00.000Z"]);
    expect((await client.bot.routine.list({ botId }))[0]?.nextRunAt).toEqual(
      new Date("2026-10-20T07:00:00.000Z"),
    );
  });

  it("on weekdays never fires on Saturday or Sunday, and the Monday after the October change is 08:00 GMT", async () => {
    // Friday 23 October, 10:00 in London: that day's 08:00 has passed.
    const { conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: new Date("2026-10-23T09:00:00.000Z"),
    });
    expect(await queuedFires(routineId)).toEqual(["2026-10-26T08:00:00.000Z"]);

    advanceTo("2026-10-24T07:00:00.000Z");
    await runDue();
    advanceTo("2026-10-25T08:00:00.000Z");
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([]);

    advanceTo("2026-10-26T08:00:00.000Z");
    await runDue();
    expect((await routineTriggers(conversationId)).map((trigger) => trigger.id)).toEqual([
      `routine:${routineId}:2026-10-26T08:00:00.000Z`,
    ]);
  });

  it("never makes a second Trigger for a slot", async () => {
    const { deps, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    advanceTo(mondaySlot);
    await runDue();

    // The slot's job ran, so its key is free again: a second fire of it is queued.
    await deps
      .plugin("runner")
      .enqueue(
        routineFireJobName,
        { routineId, slot: mondaySlot },
        { idempotencyKey: `routine:${routineId}:${mondaySlot}` },
      );
    await runDue();

    expect(await routineTriggers(conversationId)).toHaveLength(1);
  });

  it("gives the Model the wake notice and the snapshot as one input turn, and saves no user Message for it", async () => {
    const { fake, client, botId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const input = inputOf(fake.calls.at(-1));
    // The Turn's newest input is the fire, so the time opens it, not the answered user Message.
    expect(input.at(-1)).toEqual({
      role: "user",
      content:
        `[Current time: Monday, 19 October 2026 at 08:00 (Europe/London)]\n\n` +
        `${wakeNotice}\n\n${morningBrief.prompt}`,
    });
    // The answered Message stays as its own Turn sent it, with that Turn's time.
    expect(input[0]).toEqual({
      role: "user",
      content:
        "[Current time: Sunday, 18 October 2026 at 11:00 (Europe/London)]\n\nSet it up, please",
    });
    const { messages } = await client.bot.get({ botId });
    expect(messages.filter((sent) => sent.role === "user").map((sent) => sent.text)).toEqual([
      "Set it up, please",
    ]);
  });

  it("keeps the snapshot a Turn reads when the Routine's prompt is edited mid-Turn", async () => {
    const { fake, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    advanceTo(mondaySlot);
    await runDue();
    await getTestDb()
      .update(botRoutine)
      .set({ prompt: "Something else entirely." })
      .where(eq(botRoutine.id, routineId));
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const content = JSON.stringify(inputOf(fake.calls.at(-1)));
    expect(content).toContain(morningBrief.prompt);
    expect(content).not.toContain("Something else entirely.");
  });

  it("joins the Turn of user Messages waiting to start, which takes both", async () => {
    const { fake, botId, conversationId, runDue, advanceTo, sendSaved } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    advanceTo("2026-10-19T06:59:59.800Z");
    await sendSaved("Good morning");
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(2);
    const [fired] = await routineTriggers(conversationId);
    expect(fired?.turnId).toBe(turns[1]!.id);
    const contents = inputOf(fake.calls.at(-1)).map((entry) => String(entry.content));
    expect(contents.some((content) => content.endsWith("Good morning"))).toBe(true);
    expect(contents.at(-1)).toContain(wakeNotice);
  });

  it("is interrupted by a user send during its Turn, and the next Turn takes the Message", async () => {
    const hanging = round(sends({ text: "Your calendar…", endTurn: true }));
    const { fake, botId, runDue, advanceTo, sendSaved, timer } = await approvedRoutine({
      at: sunday,
      rounds: [hanging, round(sends({ text: "Hi!", endTurn: true }))],
      manual: true,
    });
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    const running = runDue();
    // The Routine's Turn waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(3);

    await sendSaved("Stop, I'm up already");
    // The heartbeat sees the cancel, and the Routine's Turn ends as its attempt aborts.
    timer.tick();
    await running;
    await expect
      .poll(async () => (await turnsOf(botId)).map((turn) => turn.status))
      .toEqual(["complete", "stopped", "running"]);
    await fake.releaseAll();
    advanceTo("2026-10-19T07:00:01.500Z");
    await runDue();

    expect((await turnsOf(botId)).map((turn) => turn.status)).toEqual([
      "complete",
      "stopped",
      "complete",
    ]);
    const last = inputOf(fake.calls.at(-1));
    expect(String(last.at(-1)?.content)).toContain("Stop, I'm up already");
  });

  it("ends a run whose Model sends nothing with no Message, and the read reports a quiet run with its provenance", async () => {
    const { client, botId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    const before = (await client.bot.get({ botId })).messages;
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const read = await client.bot.get({ botId });
    expect(read.messages).toEqual(before);
    expect(read.turns.at(-1)).toMatchObject({
      status: "complete",
      sent: false,
      triggers: [
        {
          source: "routine",
          channel: "schedule",
          routineName: "morning-brief",
          at: new Date(mondaySlot),
        },
      ],
    });
    // The user's own Trigger reads as theirs, and that Turn sent nothing either.
    expect(read.turns[0]).toMatchObject({
      triggers: [{ source: "user", channel: "web", routineName: null }],
    });
  });

  it("reads the status of the Turn that took the user's last Message apart from a later quiet run's", async () => {
    const { client, botId, runDue, advanceTo, sendSaved } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    await sendSaved("Anything for me?");
    await client.bot.stop({ botId });
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const read = await client.bot.get({ botId });
    expect(read.bot).toMatchObject({ turnStatus: "complete", userTurnStatus: "stopped" });

    // The user's next Message reads as its own Turn's.
    await sendSaved("Hello?");
    expect((await client.bot.get({ botId })).bot.userTurnStatus).toBe("running");
  });

  it("reads a run that sent a Message as sent, beside each earlier Turn with its own Triggers", async () => {
    const { client, botId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round(sends({ text: "Your calendar is clear.", endTurn: true }))],
    });
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    const { turns } = await client.bot.get({ botId });
    expect(turns.map(({ sent, triggers }) => ({ sent, triggers }))).toEqual([
      {
        sent: false,
        triggers: [{ source: "user", channel: "web", routineName: null, at: expect.any(Date) }],
      },
      {
        sent: true,
        triggers: [
          {
            source: "routine",
            channel: "schedule",
            routineName: "morning-brief",
            at: new Date(mondaySlot),
          },
        ],
      },
    ]);
  });

  it("after a clock jump over three slots fires once, and counts the next slot from then", async () => {
    const { conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });

    // Wednesday 21 October, 13:00 in London: Monday's, Tuesday's and Wednesday's slots passed.
    advanceTo("2026-10-21T12:00:00.000Z");
    await runDue();

    expect((await routineTriggers(conversationId)).map((trigger) => trigger.id)).toEqual([
      `routine:${routineId}:${mondaySlot}`,
    ]);
    expect(await queuedFires(routineId)).toEqual(["2026-10-22T07:00:00.000Z"]);
  });

  it("in Europe/London keeps 08:00 local across the March change", async () => {
    // Saturday 28 March 2026, noon GMT; summer time starts at 01:00 UTC on Sunday.
    const { routineId, runDue, advanceTo } = await approvedRoutine({
      at: new Date("2026-03-28T12:00:00.000Z"),
      routine: { ...morningBrief, schedule: { days: everyDay, at: "08:00" } },
      rounds: [round()],
    });
    expect(await queuedFires(routineId)).toEqual(["2026-03-29T07:00:00.000Z"]);

    advanceTo("2026-03-29T07:00:00.000Z");
    await runDue();

    expect(await queuedFires(routineId)).toEqual(["2026-03-30T07:00:00.000Z"]);
  });

  it("in Europe/London keeps 08:00 local across the October change", async () => {
    // Saturday 24 October 2026, 13:00 in London; summer time ends at 01:00 UTC on Sunday.
    const { routineId, runDue, advanceTo } = await approvedRoutine({
      at: new Date("2026-10-24T12:00:00.000Z"),
      routine: { ...morningBrief, schedule: { days: everyDay, at: "08:00" } },
      rounds: [round()],
    });
    expect(await queuedFires(routineId)).toEqual(["2026-10-25T08:00:00.000Z"]);

    advanceTo("2026-10-25T08:00:00.000Z");
    await runDue();

    expect(await queuedFires(routineId)).toEqual(["2026-10-26T08:00:00.000Z"]);
  });

  it("in America/New_York fires a 02:30 at 03:00 on the spring-forward day", async () => {
    // Saturday 7 March 2026, 07:00 in New York; clocks jump from 02:00 to 03:00 on Sunday.
    const { routineId, runDue, advanceTo } = await approvedRoutine({
      at: new Date("2026-03-07T12:00:00.000Z"),
      timeZone: "America/New_York",
      routine: { ...morningBrief, schedule: { days: everyDay, at: "02:30" } },
      rounds: [round()],
    });
    // 03:00 EDT.
    expect(await queuedFires(routineId)).toEqual(["2026-03-08T07:00:00.000Z"]);

    advanceTo("2026-03-08T07:00:00.000Z");
    await runDue();

    // Monday's 02:30 EDT.
    expect(await queuedFires(routineId)).toEqual(["2026-03-09T06:30:00.000Z"]);
  });

  it("makes no Trigger while the user's Quota is spent, and still queues the next fire", async () => {
    let quota: Awaited<ReturnType<NonNullable<TestDepsOverrides["getQuota"]>>> = null;
    const { user, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      host: true,
      getQuota: async () => quota,
    });
    quota = { budgetUsd: 0.0002, window: "month" };
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "turn",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: new Date(),
    });

    advanceTo(mondaySlot);
    await runDue();

    expect(await routineTriggers(conversationId)).toEqual([]);
    expect(await queuedFires(routineId)).toEqual(["2026-10-20T07:00:00.000Z"]);
  });

  it("fires on the user's linked ChatGPT plan, with usage rows at cost 0, when the Bot is on a plan Model (ADR 0023)", async () => {
    const { user, conversationId, adapterCredentials, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      linked: true,
      rounds: [round()],
    });

    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    await runDue();

    expect(await routineTriggers(conversationId)).toHaveLength(1);
    // The creation Turn and the fire's Turn both ran on the plan.
    expect(adapterCredentials.length).toBeGreaterThanOrEqual(2);
    expect(new Set(adapterCredentials.map((credentials) => credentials.apiKey))).toEqual(
      new Set([planCredentials.apiKey]),
    );
    const planRows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(planRows.length).toBeGreaterThan(0);
    expect(planRows.every((row) => row.costMicros === 0)).toBe(true);
  });

  it("makes no Trigger while the user is Banned, still queues the next fire, and fires again once the Ban ends", async () => {
    let banned = false;
    const { conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      isUserBlocked: async () => banned,
    });
    banned = true;

    advanceTo(mondaySlot);
    await runDue();

    expect(await routineTriggers(conversationId)).toEqual([]);
    expect(await queuedFires(routineId)).toEqual(["2026-10-20T07:00:00.000Z"]);

    banned = false;
    advanceTo("2026-10-20T07:00:00.000Z");
    await runDue();

    expect(await routineTriggers(conversationId)).toHaveLength(1);
  });

  it("leaves no queued fire once the user is deleted", async () => {
    const { deps, user, routineId } = await approvedRoutine({ at: sunday });
    expect(await queuedFires(routineId)).toHaveLength(1);

    await deleteUserData(deps, user.id);

    expect(await queuedFires(routineId)).toEqual([]);
  });
});

const updateRoutine = (input: unknown) => toolCall({ name: "update_routine", input });
const deleteRoutine = (input: unknown) => toolCall({ name: "delete_routine", input });

describe("changing a Routine", () => {
  // Tuesday's 09:00 in London, the slot the edit below moves the Routine to.
  const tuesdayNine = "2026-10-20T08:00:00.000Z";

  it("sends an active Routine whose schedule update_routine changes back to pending, with nothing at the old slot; approving it again fires at the new one", async () => {
    const { client, botId, conversationId, routineId, runDue, advanceTo, sendSaved } =
      await approvedRoutine({
        at: sunday,
        rounds: [
          round(
            updateRoutine({ name: "morning-brief", schedule: { days: weekdays, at: "09:00" } }),
          ),
          round(),
          round(),
        ],
      });
    await sendSaved("Make it 9:00");
    advanceTo("2026-10-18T10:00:01.000Z");
    await runDue();

    const [edited] = await client.bot.routine.list({ botId });
    expect(edited).toMatchObject({
      state: "pending",
      schedule: { days: weekdays, at: "09:00" },
      nextRunAt: null,
    });
    expect(await queuedFires(routineId)).toEqual([]);
    advanceTo(mondaySlot);
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([]);

    // Monday 08:30 in London: approved again, the next run is Tuesday's 09:00.
    advanceTo("2026-10-19T07:30:00.000Z");
    await client.bot.routine.approve({ routineId });
    expect(await queuedFires(routineId)).toEqual(["2026-10-19T08:00:00.000Z"]);
    advanceTo("2026-10-19T08:00:00.000Z");
    await runDue();
    expect((await routineTriggers(conversationId)).map((trigger) => trigger.id)).toEqual([
      `routine:${routineId}:2026-10-19T08:00:00.000Z`,
    ]);
    expect(await queuedFires(routineId)).toEqual([tuesdayNine]);
  });

  it("drops a fire still waiting behind the running Turn when update_routine sends the Routine back to pending", async () => {
    const editing = round(updateRoutine({ name: "morning-brief", prompt: "Summarize my inbox." }));
    const { fake, botId, conversationId, runDue, advanceTo, sendSaved } = await approvedRoutine({
      at: sunday,
      rounds: [editing, round()],
      manual: true,
    });
    advanceTo("2026-10-19T06:59:59.000Z");
    await sendSaved("Make it about my inbox");
    advanceTo("2026-10-19T06:59:59.500Z");
    const running = runDue();
    // The user's Turn waits in its model call, and the Routine's fire queues behind it.
    await expect.poll(() => fake.calls.length).toBe(3);
    advanceTo(mondaySlot);
    await runDue();
    expect(await routineTriggers(conversationId)).toHaveLength(1);

    await fake.releaseAll();
    await running;

    expect(await routineTriggers(conversationId)).toEqual([]);
    expect(await turnsOf(botId)).toHaveLength(2);
  });

  it("keeps an active Routine active when update_routine changes neither its prompt nor its schedule", async () => {
    const { client, botId, routineId, runDue, advanceTo, sendSaved } = await approvedRoutine({
      at: sunday,
      rounds: [
        round(updateRoutine({ name: "morning-brief", prompt: morningBrief.prompt })),
        round(),
      ],
    });
    await sendSaved("Rename it");
    advanceTo("2026-10-18T10:00:01.000Z");
    await runDue();

    expect((await client.bot.routine.list({ botId }))[0]).toMatchObject({ state: "active" });
    expect(await queuedFires(routineId)).toEqual([mondaySlot]);
  });

  it("removes a Routine with delete_routine, with no OK, and nothing fires after", async () => {
    const { client, botId, conversationId, routineId, runDue, advanceTo, sendSaved } =
      await approvedRoutine({
        at: sunday,
        rounds: [round(deleteRoutine({ name: "morning-brief" })), round()],
      });
    await sendSaved("Drop the brief");
    advanceTo("2026-10-18T10:00:01.000Z");
    await runDue();

    expect(await client.bot.routine.list({ botId })).toEqual([]);
    expect(await queuedFires(routineId)).toEqual([]);
    advanceTo("2026-10-21T12:00:00.000Z");
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([]);
  });
});

describe("pausing, resuming and deleting a Routine", () => {
  it("pausing cancels the queued fire and drops a fire still waiting behind the running Turn", async () => {
    const hanging = round(sends({ text: "On it", endTurn: true }));
    const { fake, client, botId, conversationId, routineId, runDue, advanceTo, sendSaved } =
      await approvedRoutine({ at: sunday, rounds: [hanging], manual: true });
    advanceTo("2026-10-19T06:59:59.000Z");
    await sendSaved("Good morning");
    advanceTo("2026-10-19T06:59:59.500Z");
    const running = runDue();
    // The user's Turn waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(3);
    advanceTo(mondaySlot);
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([
      expect.objectContaining({ turnId: null }),
    ]);

    await client.bot.routine.pause({ routineId });

    expect(await routineTriggers(conversationId)).toEqual([]);
    expect(await queuedFires(routineId)).toEqual([]);
    expect((await client.bot.routine.list({ botId }))[0]).toMatchObject({
      state: "paused",
      nextRunAt: null,
    });
    await fake.releaseAll();
    await running;
    advanceTo("2026-10-21T12:00:00.000Z");
    await runDue();
    expect((await turnsOf(botId)).map((turn) => turn.status)).toEqual(["complete", "complete"]);
    expect(await routineTriggers(conversationId)).toEqual([]);
  });

  it("lets a fire the running Turn already took finish when the Routine is paused", async () => {
    const hanging = round(sends({ text: "Three meetings today.", endTurn: true }));
    const { fake, client, botId, conversationId, routineId, runDue, advanceTo } =
      await approvedRoutine({ at: sunday, rounds: [hanging], manual: true });
    advanceTo(mondaySlot);
    await runDue();
    advanceTo("2026-10-19T07:00:00.500Z");
    const running = runDue();
    await expect.poll(() => fake.calls.length).toBe(3);

    await client.bot.routine.pause({ routineId });
    await fake.releaseAll();
    await running;

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["complete", "complete"]);
    expect(await routineTriggers(conversationId)).toEqual([
      expect.objectContaining({ turnId: turns[1]!.id }),
    ]);
    const { messages } = await client.bot.get({ botId });
    expect(messages.at(-1)?.text).toBe("Three meetings today.");
  });

  it("resuming queues the next slot with no approval, and it fires", async () => {
    const { client, botId, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    await client.bot.routine.pause({ routineId });
    // Monday's slot passes while it is paused.
    advanceTo("2026-10-19T12:00:00.000Z");
    await runDue();

    await client.bot.routine.resume({ routineId });

    expect((await client.bot.routine.list({ botId }))[0]).toMatchObject({ state: "active" });
    expect(await queuedFires(routineId)).toEqual(["2026-10-20T07:00:00.000Z"]);
    advanceTo("2026-10-20T07:00:00.000Z");
    await runDue();
    expect((await routineTriggers(conversationId)).map((trigger) => trigger.id)).toEqual([
      `routine:${routineId}:2026-10-20T07:00:00.000Z`,
    ]);
  });

  it("deleting stops all fires", async () => {
    const { client, botId, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
    });

    await client.bot.routine.delete({ routineId });

    expect(await client.bot.routine.list({ botId })).toEqual([]);
    expect(await queuedFires(routineId)).toEqual([]);
    advanceTo("2026-10-23T12:00:00.000Z");
    await runDue();
    expect(await routineTriggers(conversationId)).toEqual([]);
  });

  it("gives another user NOT_FOUND for pause, resume and delete", async () => {
    const { deps, routineId } = await approvedRoutine({ at: sunday });
    const other = chatRpc({ user: await insertUser(), deps });

    for (const call of [
      other.bot.routine.pause,
      other.bot.routine.resume,
      other.bot.routine.delete,
    ]) {
      await expect(call({ routineId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await queuedFires(routineId)).toEqual([mondaySlot]);
  });
});

describe("a Routine whose chain of fires broke", () => {
  /** Ends the Routine's queued fire as failed with nothing queued after it: an `onFailed` that threw. */
  const breakChain = (routineId: string) =>
    getTestDb()
      .update(job)
      .set({ status: "failed" })
      .where(like(job.idempotencyKey, `routine:${routineId}:%`));

  it("gets its next fire queued when the SDK starts, and it fires", async () => {
    const { deps, conversationId, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    await breakChain(routineId);
    expect(await queuedFires(routineId)).toEqual([]);

    await bot().start!(deps);
    await runDue();

    expect(await queuedFires(routineId)).toEqual([mondaySlot]);
    advanceTo(mondaySlot);
    await runDue();
    expect((await routineTriggers(conversationId)).map((trigger) => trigger.id)).toEqual([
      `routine:${routineId}:${mondaySlot}`,
    ]);
  });

  it("gets its next fire queued within the hour while the SDK runs, counted from then", async () => {
    const { deps, routineId, runDue, advanceTo } = await approvedRoutine({
      at: sunday,
      rounds: [round()],
    });
    await bot().start!(deps);
    await runDue();
    // Monday 14:00 in London: Monday's fire ran, and so did the reconciles up to now. Then
    // Tuesday's queued fire fails for good with nothing queued after it.
    advanceTo("2026-10-19T13:00:00.000Z");
    await runDue();
    await breakChain(routineId);
    expect(await queuedFires(routineId)).toEqual([]);

    // 15:00 in London: the next hour's reconcile.
    advanceTo("2026-10-19T14:00:00.000Z");
    await runDue();

    expect(await queuedFires(routineId)).toEqual(["2026-10-20T07:00:00.000Z"]);
  });

  it("leaves a paused Routine and one whose fire is queued as they are", async () => {
    const queued = await approvedRoutine({ at: sunday });
    const paused = await approvedRoutine({ at: sunday });
    await paused.client.bot.routine.pause({ routineId: paused.routineId });

    await bot().start!(queued.deps);
    await queued.runDue();

    expect(await queuedFires(queued.routineId)).toEqual([mondaySlot]);
    expect(await queuedFires(paused.routineId)).toEqual([]);
  });
});
