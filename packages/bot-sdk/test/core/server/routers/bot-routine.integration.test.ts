import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botPromptStart, botRoutine, botTurn } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-5.6";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key, a Bot on `model`, and a client over a Bot-enabled SDK whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    deps: () => deps!,
  });
  deps = createTestSdk({ plugins: [bot()], jobs, adapterFor: () => fake.adapter });
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
  const created = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, user, botId: created.id };
}

/** Sends `text` from `timeZone` and reads the whole stream, until the Turn that took it ends. */
async function send(
  client: ReturnType<typeof chatRpc>,
  botId: string,
  text: string,
  timeZone?: string,
) {
  const events = [];
  for await (const event of await followSend(client, { botId, id: uuidv7(), text, timeZone })) {
    events.push(event);
  }
  return events;
}

const createRoutine = (input: unknown) => toolCall({ name: "create_routine", input });

const morningBrief = {
  name: "morning-brief",
  prompt: "Summarize today's calendar.\nKeep it short.",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], at: "08:00" },
};

const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The tool results the Model read in one call, in order. */
const toolResults = (call: TextOptions | undefined) =>
  inputOf(call)
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(String(entry.content)) as { saved?: string; error?: string });

const routinesOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botRoutine)
    .where(eq(botRoutine.botId, botId))
    .orderBy(asc(botRoutine.name));

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

describe("createRoutine", () => {
  it("saves a pending Routine in the newest Message's zone, made by the Turn, and the Turn goes on", async () => {
    const { fake, client, botId } = await botWith([round(createRoutine(morningBrief)), round()]);

    const events = await send(client, botId, "Brief me every weekday at 8", "Europe/London");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    const [turn] = await turnsOf(botId);
    const routines = await routinesOf(botId);
    expect(routines).toEqual([
      expect.objectContaining({
        name: "morning-brief",
        prompt: morningBrief.prompt,
        schedule: morningBrief.schedule,
        timeZone: "Europe/London",
        state: "pending",
        createdByTurnId: turn?.id,
        approvedAt: null,
      }),
    ]);
    // The Turn went on to its next Step, which read that the Routine waits for approval.
    expect(fake.calls).toHaveLength(2);
    expect(toolResults(fake.calls[1])).toEqual([
      { saved: "Saved; it runs once the user approves it." },
    ]);
  });

  it("takes UTC when the newest Message carries no zone", async () => {
    const { client, botId } = await botWith([round(createRoutine(morningBrief)), round()]);

    await send(client, botId, "Brief me every weekday at 8");

    expect((await routinesOf(botId))[0]?.timeZone).toBe("UTC");
  });

  it("refuses a second Routine with the same name for the Bot with a clear tool error", async () => {
    const { fake, client, botId } = await botWith([
      round(createRoutine(morningBrief)),
      round(createRoutine({ ...morningBrief, prompt: "Something else." })),
      round(),
    ]);

    await send(client, botId, "Brief me every weekday at 8");

    expect(await routinesOf(botId)).toHaveLength(1);
    expect((await routinesOf(botId))[0]?.prompt).toBe(morningBrief.prompt);
    expect(toolResults(fake.calls[2])[1]?.error).toMatch(
      /already.*"morning-brief"|"morning-brief".*already/,
    );
  });

  it.each([
    ["an empty days", { days: [], at: "08:00" }, /days must name at least one day/],
    ["a malformed at", { days: ["mon"], at: "8am" }, /at must be a 24-hour time as HH:MM/],
    ["an hour past 23", { days: ["mon"], at: "24:00" }, /at must be a 24-hour time as HH:MM/],
  ])("refuses %s with a clear tool error, and saves nothing", async (_case, schedule, error) => {
    const { fake, client, botId } = await botWith([
      round(createRoutine({ ...morningBrief, schedule })),
      round(),
    ]);

    await send(client, botId, "Brief me");

    expect(await routinesOf(botId)).toEqual([]);
    expect(toolResults(fake.calls[1])[0]?.error).toMatch(error);
  });

  it("refuses a name that is not a slug with a clear tool error", async () => {
    const { fake, client, botId } = await botWith([
      round(createRoutine({ ...morningBrief, name: "Morning Brief" })),
      round(),
    ]);

    await send(client, botId, "Brief me");

    expect(await routinesOf(botId)).toEqual([]);
    expect(toolResults(fake.calls[1])[0]?.error).toMatch(/name must be a slug/);
  });
});

describe("the system prompt's Routines", () => {
  it("lists the Bot's Routines in the next Prompt start built, sorted by name, pending ones marked (waiting for OK)", async () => {
    const { fake, client, botId } = await botWith([
      round(
        createRoutine(morningBrief),
        createRoutine({
          name: "inbox-sweep",
          prompt: "Sweep the inbox.",
          schedule: { days: ["sat", "sun"], at: "18:30" },
        }),
      ),
      round(),
      round(),
    ]);
    await send(client, botId, "Set up my routines", "Europe/London");
    const [first] = (await client.bot.routine.list({ botId })).filter(
      (routine) => routine.name === "morning-brief",
    );
    await client.bot.routine.approve({ routineId: first!.id });
    // The Prompt start keeps the Routines it was built with; the next one built (as a Summary
    // would build it) lists them.
    await getTestDb().delete(botPromptStart).where(eq(botPromptStart.botId, botId));

    await send(client, botId, "Thanks");

    const prompt = JSON.stringify(fake.calls[2]?.systemPrompts);
    const lines = (fake.calls[2]?.systemPrompts ?? [])
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("inbox-sweep") || line.startsWith("morning-brief"));
    expect(lines).toEqual([
      'inbox-sweep  weekends 18:30 Europe/London  "Sweep the inbox." (waiting for OK)',
      'morning-brief  weekdays 08:00 Europe/London  "Summarize today\'s calendar."',
    ]);
    // The first Turn had no Routines yet.
    expect(JSON.stringify(fake.calls[0]?.systemPrompts)).not.toContain("morning-brief");
    expect(prompt).toContain("waiting for OK");
  });
});

describe("bot.routine", () => {
  async function withPendingRoutine() {
    const made = await botWith([round(createRoutine(morningBrief)), round()]);
    await send(made.client, made.botId, "Brief me every weekday at 8", "Europe/London");
    const [routine] = await made.client.bot.routine.list({ botId: made.botId });
    return { ...made, routine: routine! };
  }

  it("lists the Bot's Routines, and puts each one's approval in the thread as a control Message", async () => {
    const { client, botId, routine } = await withPendingRoutine();
    const { messages } = await client.bot.get({ botId });

    expect(routine).toMatchObject({
      name: "morning-brief",
      prompt: morningBrief.prompt,
      schedule: morningBrief.schedule,
      timeZone: "Europe/London",
      state: "pending",
      approvedAt: null,
    });
    expect(routine).not.toHaveProperty("afterMessageId");
    const approvals = messages.filter((sent) => sent.control?.kind === "routine_approval");
    expect(approvals).toEqual([
      expect.objectContaining({
        role: "assistant",
        control: { kind: "routine_approval", routineId: routine.id },
      }),
    ]);
  });

  it("bumps the change log when the Message is written, and again when the Routine is approved", async () => {
    const { client, botId, routine } = await withPendingRoutine();
    const { messages } = await client.bot.get({ botId });
    const approval = messages.find((sent) => sent.control?.kind === "routine_approval")!;

    await client.bot.routine.approve({ routineId: routine.id });

    const changed = await client.bot.changes({ botId, since: 0 });
    if (changed.reload) throw new Error("expected changes");
    const kinds = changed.changes.map((change) => `${change.kind}:${change.refId}`);
    expect(kinds).toContain(`message:${approval.id}`);
    expect(kinds.filter((kind) => kind === `routine:${routine.id}`)).toHaveLength(2);
    // Approving never wakes the Bot, and adds no Message.
    expect(await turnsOf(botId)).toHaveLength(1);
    expect((await client.bot.get({ botId })).messages).toHaveLength(messages.length);
  });

  it("approve sets the Routine active with approvedAt, and starts no Turn", async () => {
    const { client, botId, routine } = await withPendingRoutine();

    const approved = await client.bot.routine.approve({ routineId: routine.id });

    expect(approved).toMatchObject({ id: routine.id, state: "active" });
    const [row] = await routinesOf(botId);
    expect(row?.state).toBe("active");
    expect(row?.approvedAt).toBeInstanceOf(Date);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("decline deletes the Routine, and starts no Turn", async () => {
    const { client, botId, routine } = await withPendingRoutine();

    await client.bot.routine.decline({ routineId: routine.id });

    expect(await routinesOf(botId)).toEqual([]);
    expect(await client.bot.routine.list({ botId })).toEqual([]);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("decline leaves an approved Routine as it is", async () => {
    const { client, botId, routine } = await withPendingRoutine();
    await client.bot.routine.approve({ routineId: routine.id });

    await client.bot.routine.decline({ routineId: routine.id });

    expect((await routinesOf(botId))[0]?.state).toBe("active");
  });

  it("gives another user NOT_FOUND for the Routine and the Bot's list", async () => {
    const { deps, botId, routine } = await withPendingRoutine();
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.routine.approve({ routineId: routine.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(other.bot.routine.decline({ routineId: routine.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(other.bot.routine.list({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await routinesOf(botId))[0]?.state).toBe("pending");
  });

  it("deleting the user removes their Routines", async () => {
    const { deps, user, botId } = await withPendingRoutine();

    await deleteUserData(deps, user.id);

    expect(await routinesOf(botId)).toEqual([]);
  });
});
