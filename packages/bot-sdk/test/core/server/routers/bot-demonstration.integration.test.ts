import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  botDemonstration,
  botDemonstrationEvent,
  botHelper,
  botTurn,
} from "../../../../core/server/storage";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  computerUseHelperHoldsScreenError,
  demonstrationEndedWhileOpeningError,
  demonstrationRunningError,
} from "../../../../plugins/bot/server/demonstrations";
import {
  demonstrationHoldsScreenError,
  screensInUseError,
} from "../../../../plugins/bot/server/helpers";
import { findBot } from "../../../../plugins/bot/server/conversation";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import {
  inProcessRunner,
  type InProcessRunner,
  claimJob,
} from "../../../../plugins/runner/server/internal";
import { skills } from "../../../../plugins/skills/server/plugin";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { type FakeCommandRun, fakeComputerProvider } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const minuteMs = 60_000;
const start = new Date("2030-03-15T12:00:00.000Z");
const screenScript = "/usr/local/bin/ai-chat-screen";

type Round = ReturnType<typeof round>;

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const goal = "Copy this week's payouts into the sheet";
const inputs = ["the week"];

const runTool = (name: string, args: unknown) =>
  toolCall({ name: "run_tool", input: { name, args } });
const watchUser = (args: unknown = { goal, inputs }) => runTool("watch_user", args);
const ends = () => toolCall({ name: "send_to_user", input: { text: "Go ahead.", endTurn: true } });

/**
 * A user with an OpenAI key and a Bot "Ada", over `bot`, `computer` and (unless told otherwise)
 * `skills`, on a runner that runs only when the test says, with a clock the test moves. The Bot's
 * Turns play `rounds` in order.
 */
async function botWith(
  rounds: Round[],
  {
    withSkills = true,
    onCommand,
  }: {
    withSkills?: boolean;
    /** Answers the Computer's commands, `exit 0` by default. */
    onCommand?: (command: FakeCommandRun) => Promise<{ exitCode: number } | undefined>;
  } = {},
) {
  const timer = fakeJobClock(start);
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider({
    onCommand: async (command) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...(await onCommand?.(command)),
    }),
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    features: withSkills ? [skills()] : [],
    memory: false,
    jobs,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
  });
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const newBot = async () => (await client.bot.create({ name: "Ada", model })).id;
  const botId = await newBot();
  /** Runs every job due at the clock's time, until none is. */
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** Sends `text` to Bot `to` and runs its Turn. */
  const send = async (text: string, to = botId) => {
    const stream = await followSend(client, { botId: to, id: uuidv7(), text });
    await stream.next();
    await stream.return(undefined);
    timer.advance(500);
    await runDue();
  };
  /** Moves the clock on by `ms`, a minute at a time, running what falls due. */
  const pass = async (ms: number) => {
    for (let left = ms; left > 0; left -= minuteMs) {
      timer.advance(Math.min(minuteMs, left));
      await runDue();
    }
  };
  return { fake, computerFake, deps: deps!, client, user, botId, newBot, send, pass };
}

const demonstrationsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botDemonstration)
    .where(eq(botDemonstration.botId, botId))
    .orderBy(asc(botDemonstration.startedAt));

/** Each tool call of Bot `botId`'s Turns, with its parsed result, in order. */
async function toolResults(botId: string) {
  const turns = await getTestDb()
    .select({ transcript: botTurn.transcript })
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt));
  return turns.flatMap(({ transcript }) => {
    const entries = (transcript ?? []) as ModelMessage[];
    return entries
      .flatMap((entry) => entry.toolCalls ?? [])
      .map((call) => {
        const args = JSON.parse(call.function.arguments) as { name?: string };
        return {
          name: call.function.name === "run_tool" ? args.name : call.function.name,
          result: JSON.parse(
            String(entries.find((entry) => entry.toolCallId === call.id)?.content ?? "null"),
          ),
        };
      });
  });
}

const resultOf = async (botId: string, name: string) =>
  (await toolResults(botId)).filter((call) => call.name === name).map((call) => call.result);

const screenCommands = (computerFake: ReturnType<typeof fakeComputerProvider>) =>
  computerFake
    .callsOf("run")
    .map((call) => call.command)
    .filter((command) => command.startsWith(screenScript));

const firstMessageOf = (call: TextOptions | undefined) =>
  String(((call?.messages ?? []) as ModelMessage[])[0]?.content);

describe("watch_user", { timeout: 30_000 }, () => {
  it("is a deferred tool whose line tells the Bot to ask for the goal and the inputs first", async () => {
    const { fake, send } = await botWith([round()]);

    await send("hello");

    const call = fake.calls[0];
    expect((call?.tools ?? []).map((tool) => tool.name)).not.toContain("watch_user");
    const first = firstMessageOf(call);
    const deferred = first.slice(first.indexOf("[Deferred tools"));
    expect(deferred).toMatch(
      /watch_user: .*first ask them for the goal and what changes each time, unless they already said/,
    );
  });

  it("isn't offered without the skills plugin", async () => {
    const { fake, send, botId } = await botWith([round(watchUser(), ends()), round()], {
      withSkills: false,
    });

    await send("let me show you how I copy the payouts");

    expect(firstMessageOf(fake.calls[0])).not.toContain("watch_user");
    expect(await resultOf(botId, "watch_user")).toEqual([
      { error: expect.stringContaining("No tool named watch_user") },
    ]);
    expect(await demonstrationsOf(botId)).toEqual([]);
  });

  it("starts a recording Demonstration on the Bot's Screen, posts its card and returns at once", async () => {
    const { client, computerFake, send, botId, user } = await botWith([
      round(watchUser(), ends()),
      round(),
    ]);

    await send("let me show you how I copy the payouts");

    const [row] = await demonstrationsOf(botId);
    expect(row).toMatchObject({
      userId: user.id,
      goal,
      inputs,
      state: "recording",
      screen: 1,
      startedAt: new Date(start.getTime() + 500),
      endedAt: null,
      skillName: null,
    });
    expect(await resultOf(botId, "watch_user")).toEqual([
      { demonstrationId: row!.id, state: "recording" },
    ]);
    // Opened afresh on the Bot's profile, and in control mode for the user.
    expect(screenCommands(computerFake)).toEqual([
      `${screenScript} start 1 ${botId}`,
      `${screenScript} control 1`,
    ]);
    // The Turn ended as usual; the Demonstration outlives it.
    const { bot: shown, messages } = await client.bot.get({ botId });
    expect(shown.turnStatus).toBe("complete");
    expect(messages.find((message) => message.control)?.control).toEqual({
      kind: "demonstration",
      demonstrationId: row!.id,
      goal,
      state: "recording",
      startedAt: row!.startedAt.toISOString(),
      endedAt: null,
      steps: 0,
    });
    // The card comes before the Bot's message of the same Turn.
    expect(messages.map((message) => message.text)).toEqual([
      "let me show you how I copy the payouts",
      goal,
      "Go ahead.",
    ]);
  });

  it("errors while the Bot's Computer-use Helper holds its Screen", async () => {
    const { send, botId } = await botWith([round(), round(watchUser(), ends()), round()]);
    await send("hello");
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    await getTestDb().insert(botHelper).values({
      id: uuidv7(),
      botId,
      type: "computer_use",
      task: "Sign in.",
      status: "waiting",
      startedByTurnId: turn!.id,
      screen: 1,
      startedAt: start,
    });

    await send("let me show you how I copy the payouts");

    expect(await resultOf(botId, "watch_user")).toEqual([
      { error: computerUseHelperHoldsScreenError },
    ]);
    expect(await demonstrationsOf(botId)).toEqual([]);
  });

  it("errors while another Demonstration of the Bot runs, and start_helper's Computer-use Helper errors too", async () => {
    const startComputerUse = toolCall({
      name: "start_helper",
      input: { type: "computer_use", task: "Read the payouts." },
    });
    const { send, botId } = await botWith([
      round(watchUser(), ends()),
      round(watchUser(), startComputerUse, ends()),
      round(),
    ]);
    await send("let me show you");

    await send("and again");

    expect(await resultOf(botId, "watch_user")).toEqual([
      expect.objectContaining({ state: "recording" }),
      { error: demonstrationRunningError },
    ]);
    expect(await resultOf(botId, "start_helper")).toEqual([
      { error: demonstrationHoldsScreenError },
    ]);
    expect(await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId))).toEqual(
      [],
    );
  });

  it("errors when all four Screens are in use, which Demonstrations count toward", async () => {
    const { send, botId, newBot, user } = await botWith([round(watchUser(), ends()), round()]);
    for (let slot = 1; slot <= 4; slot += 1) {
      const other = await newBot();
      const { conversationId } = (await findBot(getTestDb(), user.id, other))!;
      await getTestDb()
        .insert(botDemonstration)
        .values({
          id: uuidv7(),
          botId: other,
          userId: user.id,
          conversationId,
          goal: "Other",
          inputs: [],
          state: slot === 4 ? "paused" : "recording",
          screen: slot,
          startedAt: start,
        });
    }

    await send("let me show you");

    expect(await resultOf(botId, "watch_user")).toEqual([{ error: screensInUseError }]);
  });
});

describe("watch_user's Screen", { timeout: 30_000 }, () => {
  const opening = (botId: () => string) => (command: FakeCommandRun) =>
    command.command === `${screenScript} control 1` && botId() !== "";

  it("cancels the Demonstration and closes the Screen when it won't open", async () => {
    let botId = "";
    const { client, computerFake, send, ...setup } = await botWith(
      [round(watchUser(), ends()), round()],
      {
        onCommand: async (command) => (opening(() => botId)(command) ? { exitCode: 1 } : undefined),
      },
    );
    botId = setup.botId;

    await send("let me show you");

    expect(await resultOf(botId, "watch_user")).toEqual([
      { error: expect.stringContaining("The Screen didn't open") },
    ]);
    expect(await stateOf(botId)).toBe("cancelled");
    expect((await cardOf(client, botId))?.state).toBe("cancelled");
    expect(screenCommands(computerFake).at(-1)).toBe(`${screenScript} stop 1`);
  });

  it("closes the Screen again when the user ended the Demonstration while it opened", async () => {
    let botId = "";
    let client: ReturnType<typeof chatRpc> | undefined;
    const setup = await botWith([round(watchUser(), ends()), round()], {
      onCommand: async (command) => {
        if (!opening(() => botId)(command)) return undefined;
        const [row] = await demonstrationsOf(botId);
        await client!.bot.demonstration.cancel({ demonstrationId: row!.id });
        return undefined;
      },
    });
    ({ botId, client } = setup);

    await setup.send("let me show you");

    expect(await resultOf(botId, "watch_user")).toEqual([
      { error: demonstrationEndedWhileOpeningError },
    ]);
    expect(await stateOf(botId)).toBe("cancelled");
    // The cancel closed it during control mode; watch_user closes it once more after.
    expect(screenCommands(setup.computerFake).slice(-3)).toEqual([
      `${screenScript} control 1`,
      `${screenScript} stop 1`,
      `${screenScript} stop 1`,
    ]);
  });
});

/** A Bot whose first Turn started a Demonstration, which it returns. */
async function demonstrating() {
  const setup = await botWith([round(watchUser(), ends()), round()]);
  await setup.send("let me show you how I copy the payouts");
  const [row] = await demonstrationsOf(setup.botId);
  return { ...setup, demonstrationId: row!.id };
}

const stateOf = async (botId: string) => (await demonstrationsOf(botId))[0]?.state;

const cardOf = async (client: ReturnType<typeof chatRpc>, botId: string) => {
  for (const { control } of (await client.bot.get({ botId })).messages)
    if (control?.kind === "demonstration") return control;
  return undefined;
};

describe("the Demonstration's routes", { timeout: 30_000 }, () => {
  it("pause and resume move between recording and paused, and are no-ops from the other state", async () => {
    const { client, botId, demonstrationId } = await demonstrating();
    const act = client.bot.demonstration;

    expect(await act.resume({ demonstrationId })).toEqual({ state: "recording" });
    expect(await act.pause({ demonstrationId })).toEqual({ state: "paused" });
    expect(await stateOf(botId)).toBe("paused");
    expect((await cardOf(client, botId))?.state).toBe("paused");
    expect(await act.pause({ demonstrationId })).toEqual({ state: "paused" });
    expect(await act.resume({ demonstrationId })).toEqual({ state: "recording" });
    expect((await cardOf(client, botId))?.state).toBe("recording");
  });

  it("Done ends it drafting and releases its Screen; later actions change nothing", async () => {
    const { client, botId, computerFake, demonstrationId } = await demonstrating();
    const act = client.bot.demonstration;
    await act.pause({ demonstrationId });

    expect(await act.done({ demonstrationId })).toEqual({ state: "drafting" });

    const [row] = await demonstrationsOf(botId);
    expect(row).toMatchObject({ state: "drafting", endedAt: expect.any(Date) });
    expect(await cardOf(client, botId)).toMatchObject({
      state: "drafting",
      endedAt: row!.endedAt!.toISOString(),
    });
    expect(screenCommands(computerFake).at(-1)).toBe(`${screenScript} stop 1`);
    for (const action of ["pause", "resume", "done", "cancel"] as const) {
      expect(await act[action]({ demonstrationId })).toEqual({ state: "drafting" });
    }
    await expect(act.view({ demonstrationId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("Cancel ends it cancelled, throws away its steps and screenshots, and releases its Screen", async () => {
    const { client, botId, computerFake, demonstrationId, deps } = await demonstrating();
    const key = `demonstration/${demonstrationId}/step`;
    await deps.blobStore.put(key, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    await getTestDb().insert(botDemonstrationEvent).values({
      id: uuidv7(),
      demonstrationId,
      sequence: 1,
      offsetMs: 0,
      kind: "click",
      url: "https://example.test/",
      screenshotKey: key,
    });

    expect(await client.bot.demonstration.cancel({ demonstrationId })).toEqual({
      state: "cancelled",
    });

    // The row stays as a record; nothing it captured does.
    expect(
      await getTestDb()
        .select()
        .from(botDemonstrationEvent)
        .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId)),
    ).toEqual([]);
    expect(await deps.blobStore.get(key)).toBeNull();
    expect(await stateOf(botId)).toBe("cancelled");
    expect((await cardOf(client, botId))?.state).toBe("cancelled");
    expect(screenCommands(computerFake).at(-1)).toBe(`${screenScript} stop 1`);
    expect(await client.bot.demonstration.done({ demonstrationId })).toEqual({
      state: "cancelled",
    });
  });

  it("acts only on the user's own Demonstration", async () => {
    const { deps, botId, demonstrationId } = await demonstrating();
    const stranger = chatRpc({ user: await insertUser(), deps });

    await expect(stranger.bot.demonstration.cancel({ demonstrationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(stranger.bot.demonstration.view({ demonstrationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await stateOf(botId)).toBe("recording");
  });

  it("view gives a live-view link to its Screen", async () => {
    const { client, demonstrationId } = await demonstrating();

    const { url } = await client.bot.demonstration.view({ demonstrationId });

    expect(url).toMatch(/^\/api\/screens\/[\w-]+\.[\w-]+\//);
  });
});

describe("a Ban", { timeout: 30_000 }, () => {
  it("cancels the user's live Demonstrations, which releases their Screens", async () => {
    const { deps, user, client, botId, computerFake } = await demonstrating();

    await deps.bots.stopTurns(user.id);

    expect(await stateOf(botId)).toBe("cancelled");
    expect((await cardOf(client, botId))?.state).toBe("cancelled");
    expect(screenCommands(computerFake).at(-1)).toBe(`${screenScript} stop 1`);
  });
});

describe("the time cap", { timeout: 30_000 }, () => {
  it("ends it as Done after 15 minutes of recording, not counting paused time", async () => {
    const { client, botId, computerFake, demonstrationId, pass } = await demonstrating();

    await pass(5 * minuteMs);
    await client.bot.demonstration.pause({ demonstrationId });
    await pass(5 * minuteMs);
    await client.bot.demonstration.resume({ demonstrationId });
    await pass(9 * minuteMs);
    expect(await stateOf(botId)).toBe("recording");

    await pass(2 * minuteMs);

    // Done, so its drafting pass ran on (bot-demonstration-draft covers how that ends).
    const [row] = await demonstrationsOf(botId);
    expect(["saved", "failed"]).toContain(row!.state);
    expect(row!.endedAt).toEqual(expect.any(Date));
    expect(["saved", "failed"]).toContain((await cardOf(client, botId))?.state);
    expect(screenCommands(computerFake)).toContain(`${screenScript} stop 1`);
  });

  it("ends one left paused as Done an hour after it started, which frees its Screen", async () => {
    const { client, botId, computerFake, demonstrationId, pass } = await demonstrating();
    await client.bot.demonstration.pause({ demonstrationId });

    await pass(59 * minuteMs);
    expect(await stateOf(botId)).toBe("paused");

    await pass(2 * minuteMs);

    const [row] = await demonstrationsOf(botId);
    expect(["saved", "failed"]).toContain(row!.state);
    expect(screenCommands(computerFake)).toContain(`${screenScript} stop 1`);
  });
});
