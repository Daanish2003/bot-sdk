import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  botHelper,
  botTrigger,
  botTurn,
  computer as computerTable,
  job,
  usage,
} from "../../../../core/server/db/schema";
import { deleteUserData } from "../../../../core/server/user-data";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import {
  botHelperJob,
  generalHelperPrompt,
  helperEndings,
  helperQuotaSpentError,
  helperStepLimit,
  helperTimeLimitMs,
  tooManyGeneralHelpersError,
} from "../../../../plugins/bot/server/helper";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import type { CommandResult } from "../../../../plugins/computer/server/provider";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { quotaLookup } from "../../../../plugins/models/server/quota";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import {
  claimJob,
  reapStaleJobs,
  runClaimedJob,
} from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall, withUsage } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  fakeComputerProvider,
  type FakeCommandRun,
} from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The runners the tests started, stopped after each test. */
const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) => String(prompt).startsWith("You are a Helper"));

/**
 * One adapter over two scripts, so a Helper's job and a Turn never race for the same round: the
 * Turns' model calls play `turns`, the Helpers' play `helpers`.
 */
function splitAdapter(turns: Round[], helpers: Round[], manualHelpers = false) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers, manual: manualHelpers });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      isHelperCall(options)
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as AnyTextAdapter;
  return { adapter, turnFake, helperFake };
}

/**
 * A user with an OpenAI key and a Bot, over an SDK with `computer` on (a fake provider whose
 * commands `onCommand` answers), whose in-process runner runs the Turns and the Helpers.
 */
async function botWith(
  turns: Round[],
  helpers: Round[],
  {
    withComputer = true,
    onCommand,
    manualHelpers,
    ...overrides
  }: {
    withComputer?: boolean;
    manualHelpers?: boolean;
    onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
  } & Pick<TestDepsOverrides, "clock" | "getQuota" | "hostProviders"> = {},
) {
  const fakes = splitAdapter(turns, helpers, manualHelpers);
  const computerFake = fakeComputerProvider({ onCommand });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    plugins: withComputer ? [bot(), computer({ provider: computerFake.provider })] : [bot()],
    jobs,
    adapterFor: () => fakes.adapter,
    ...overrides,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!overrides.hostProviders) {
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
    model: overrides.hostProviders ? hostModel : model,
  });
  return { ...fakes, computerFake, deps, client, user, botId: created.id };
}

const hostModel = "anthropic:claude-sonnet-5-5";

/** Sends `text` to the Bot and reads the whole stream. */
async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  const events = [];
  for await (const event of await client.bot.send({ botId, id: uuidv7(), text })) {
    events.push(event);
  }
  return events;
}

const startHelper = (task: string) =>
  toolCall({ name: "start_helper", input: { type: "general", task } });

const sends = (input: { text: string; endTurn: boolean }) =>
  toolCall({ name: "send_to_user", input });

const shell = (command: string) => toolCall({ name: "shell", input: { command } });

/** A Turn's first Step: it starts a Helper on `task` and tells the user, ending the Turn. */
const handsOff = (task: string) =>
  round(startHelper(task), sends({ text: "On it.", endTurn: true }));

const helpersOf = async (botId: string) =>
  getTestDb()
    .select()
    .from(botHelper)
    .where(eq(botHelper.botId, botId))
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));

const turnsOf = async (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

const helperTriggers = async () =>
  getTestDb().select().from(botTrigger).where(eq(botTrigger.source, "helper"));

/** The model input of one call: its messages, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The result of the first tool call `name` in `input`, parsed. */
const resultInTranscript = (input: ModelMessage[], name: string) => {
  const id = input
    .flatMap((entry) => entry.toolCalls ?? [])
    .find((c) => c.function.name === name)?.id;
  return JSON.parse(String(input.find((entry) => entry.toolCallId === id)?.content));
};

/** Waits for the Bot's Helpers to have ended, and for the Turns their reports woke to end too. */
async function settled(botId: string) {
  await expect
    .poll(async () => (await helpersOf(botId)).every((row) => row.status !== "running"), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await turnsOf(botId)).every((row) => row.status !== "running"), {
      timeout: 10_000,
    })
    .toBe(true);
}

describe("starting a General Helper", () => {
  it("creates a running Helper with its own job, and the Turn ends while it runs", async () => {
    const { client, botId, turnFake } = await botWith(
      [handsOff("Count the files in /home/user/shared.")],
      // The Helper's first model call waits until the test lets it through.
      [round(text("There are 3 files."))],
      { manualHelpers: true },
    );

    const events = await send(client, botId, "how many files are there?");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({
      type: "general",
      task: "Count the files in /home/user/shared.",
      status: "running",
      report: null,
    });
    const [turn] = await turnsOf(botId);
    expect(helper?.startedByTurnId).toBe(turn?.id);
    // The Model got the Helper's id and status back, in the Turn's transcript.
    expect(resultInTranscript(turn?.transcript ?? [], "start_helper")).toEqual({
      helperId: helper?.id,
      status: "running",
    });
    expect(turnFake.calls).toHaveLength(1);
    const [helperJob] = await getTestDb().select().from(job).where(eq(job.id, helper!.jobId!));
    expect(helperJob?.name).toBe("bot.helper");
  });
});

describe("a Helper's report", () => {
  it("runs the Helper with the Computer's tools, and its final text wakes a Turn as a helper Trigger", async () => {
    const { client, botId, helperFake, turnFake, computerFake } = await botWith(
      [
        handsOff("Count the files in /home/user/shared."),
        round(sends({ text: "3 files.", endTurn: true })),
      ],
      [round(shell("ls /home/user/shared | wc -l")), round(text("There are 3 files."))],
      { onCommand: () => ({ exitCode: 0, stdout: "3\n", stderr: "" }) },
    );

    await send(client, botId, "how many files are there?");
    await settled(botId);

    // Its own fresh context: the General Helper prompt, the Computer's tools and only its task.
    expect(helperFake.calls[0]?.systemPrompts).toEqual([generalHelperPrompt]);
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
      "shell",
      "read",
      "write",
      "edit",
      "list",
    ]);
    expect(inputOf(helperFake.calls[0])).toEqual([
      { role: "user", content: "Count the files in /home/user/shared." },
    ]);
    expect(computerFake.callsOf("run").map((call) => call.command)).toEqual([
      "ls /home/user/shared | wc -l",
    ]);
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "complete", report: "There are 3 files." });
    expect(helper?.endedAt).toBeInstanceOf(Date);
    const [trigger] = await helperTriggers();
    expect(trigger).toMatchObject({
      id: `helper:${helper?.id}:1`,
      source: "helper",
      channel: "helper",
      text:
        "General Helper finished: Count the files in /home/user/shared., status complete\n\n" +
        "There are 3 files.",
    });
    // It woke a second Turn, whose model input holds the report.
    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(2);
    expect(trigger?.turnId).toBe(turns[1]?.id);
    expect(JSON.stringify(inputOf(turnFake.calls[1]).at(-1))).toContain("There are 3 files.");
    expect((await client.bot.get({ botId })).messages.at(-1)?.text).toBe("3 files.");
  });

  it("caps the report at 2,000 characters", async () => {
    const { client, botId } = await botWith(
      [handsOff("Write a long answer."), round()],
      [round(text("x".repeat(5_000)))],
    );

    await send(client, botId, "go");
    await settled(botId);

    const [helper] = await helpersOf(botId);
    expect(helper?.status).toBe("complete");
    expect(helper?.report).toHaveLength(2_000);
  });

  it("sends one Trigger when its finish is retried", async () => {
    const { client, botId, deps } = await botWith(
      [handsOff("Say hi."), round()],
      [round(text("hi"))],
    );
    await send(client, botId, "go");
    await settled(botId);
    const [helper] = await helpersOf(botId);

    // The job's last-chance ending runs again after the Helper ended: it changes nothing.
    await botHelperJob.onFailed!({ helperId: helper!.id }, new Error("again"), deps);

    expect(await helperTriggers()).toHaveLength(1);
    expect((await helpersOf(botId))[0]).toMatchObject({ status: "complete", report: "hi" });
  });
});

describe("a Helper's limits", () => {
  it("ends error after 50 Steps, and still reports back", async () => {
    const { client, botId, helperFake } = await botWith(
      [handsOff("Loop forever."), round()],
      Array.from({ length: helperStepLimit + 1 }, () => round(shell("true"))),
    );

    await send(client, botId, "go");
    await settled(botId);

    expect(helperFake.calls).toHaveLength(helperStepLimit);
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "error", report: helperEndings.stepLimit });
    const [trigger] = await helperTriggers();
    expect(trigger?.text).toContain("status error");
    expect(trigger?.text).toContain(helperEndings.stepLimit);
    expect(await turnsOf(botId)).toHaveLength(2);
  }, 60_000);

  it("ends error past 30 minutes on the clock, and still reports back", async () => {
    let now = new Date();
    const { client, botId, helperFake } = await botWith(
      [handsOff("Take your time."), round()],
      [round(shell("slow")), round(text("Never comes."))],
      {
        clock: () => now,
        // The command takes the Helper past its limit.
        onCommand: () => {
          now = new Date(now.getTime() + helperTimeLimitMs + 1_000);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await send(client, botId, "go");
    // Only the Helper: the clock it moved is past when the Turn its report woke would run.
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 5_000 })
      .toBe("error");

    expect(helperFake.calls).toHaveLength(1);
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "error", report: helperEndings.timedOut });
    expect((await helperTriggers())[0]?.text).toContain(helperEndings.timedOut);
  });

  it("ends error when its job runs out of attempts, and still reports back", async () => {
    const hangs = round(text("Never comes."));
    const fakes = splitAdapter([handsOff("Hang."), round()], [hangs, hangs, hangs], true);
    const timer = fakeJobClock(new Date());
    let deps: TestDeps | undefined;
    // Never started: the test claims and runs each attempt.
    const jobs = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      clock: timer.clock,
      deps: () => deps!,
    });
    deps = createTestSdk({
      plugins: [bot(), computer({ provider: fakeComputerProvider().provider })],
      jobs,
      adapterFor: () => fakes.adapter,
    });
    const user = await insertUser();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const client = chatRpc({ user, deps });
    const { id: botId } = await client.bot.create({ name: "Ada", model });
    const attempt = async () => {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: false });
      if (!claimed) throw new Error("Nothing to claim");
      return runClaimedJob(getTestDb(), claimed, {
        clock: timer.clock,
        logger: silent,
        deps: () => deps!,
      });
    };
    await client.bot.send({ botId, id: uuidv7(), text: "go" });
    // The Turn's job: it starts the Helper and ends.
    await attempt();

    const lost = [attempt()];
    for (const calls of [1, 2, 3]) {
      // Each attempt waits in the Helper's first model call when its process stops.
      await expect.poll(() => fakes.helperFake.calls.length).toBe(calls);
      timer.advance(61_000);
      await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
      timer.tick();
      if (calls < 3) lost.push(attempt());
    }
    await Promise.all(lost);

    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "error", report: helperEndings.crashed });
    const [trigger] = await helperTriggers();
    expect(trigger?.id).toBe(`helper:${helper?.id}:1`);
    expect(trigger?.text).toContain(helperEndings.crashed);
    // The report started a Turn, queued for the runner.
    expect(await turnsOf(botId)).toHaveLength(2);
  });
});

describe("a Helper's Quota and usage", () => {
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
  const usageOf = (userId: string) =>
    getTestDb().select().from(usage).where(eq(usage.userId, userId)).orderBy(asc(usage.createdAt));
  const tokens = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };

  it("records each of the Helper's model calls as helper usage", async () => {
    const { client, botId, user } = await botWith(
      [handsOff("Count."), round()],
      [withUsage(round(shell("true")), tokens), withUsage(round(text("Done.")), tokens)],
      { hostProviders },
    );

    await send(client, botId, "go");
    await settled(botId);

    const rows = (await usageOf(user.id)).filter((row) => row.kind === "helper");
    expect(rows).toMatchObject([
      { kind: "helper", model: hostModel, inputTokens: 100, outputTokens: 10 },
      { kind: "helper", model: hostModel, inputTokens: 100, outputTokens: 10 },
    ]);
    const [helper] = await helpersOf(botId);
    expect(helper?.usage).toMatchObject({ input: 200, output: 20 });
  });

  it("refuses start_helper once the Quota is spent, with a next step", async () => {
    let userId = "";
    const { client, botId, turnFake, user } = await botWith(
      [
        round(shell("spend")),
        round(startHelper("Count.")),
        round(sends({ text: "I can't right now.", endTurn: true })),
      ],
      [],
      {
        hostProviders,
        // 200 micros a day.
        getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }),
        // The Quota is spent while the Turn runs, after its send was accepted.
        onCommand: async () => {
          await getTestDb().insert(usage).values({
            id: uuidv7(),
            userId,
            kind: "run",
            model: hostModel,
            inputTokens: 100,
            outputTokens: 0,
            costMicros: 300,
            estimated: false,
            createdAt: new Date(),
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    userId = user.id;

    await send(client, botId, "go");

    expect(resultInTranscript(inputOf(turnFake.calls[2]), "start_helper")).toEqual({
      error: helperQuotaSpentError,
    });
    expect(await helpersOf(botId)).toEqual([]);
  });
});

describe("how many Helpers a Bot runs", () => {
  it("refuses a fourth General Helper with a next step", async () => {
    const { client, botId } = await botWith(
      [
        round(
          startHelper("One."),
          startHelper("Two."),
          startHelper("Three."),
          startHelper("Four."),
          sends({ text: "Started.", endTurn: true }),
        ),
      ],
      // Each Helper's first model call waits, so all three are still running.
      [round(text("Never comes.")), round(text("Never comes.")), round(text("Never comes."))],
      { manualHelpers: true },
    );

    await send(client, botId, "go");

    const [turn] = await turnsOf(botId);
    const results = (turn?.transcript ?? [])
      .filter((entry) => entry.role === "tool")
      .map((entry) => JSON.parse(String(entry.content)));
    expect(results.slice(0, 4).map((result) => result.status ?? result.error)).toEqual([
      "running",
      "running",
      "running",
      tooManyGeneralHelpersError,
    ]);
    expect((await helpersOf(botId)).map((row) => row.task)).toEqual(["One.", "Two.", "Three."]);
  });
});

describe("a rebuilt Computer", () => {
  it("tells the Helper once, and still tells the Bot", async () => {
    const { client, botId, helperFake, turnFake, computerFake, deps, user } = await botWith(
      [
        handsOff("List the files."),
        round(shell("ls")),
        round(sends({ text: "Done.", endTurn: true })),
      ],
      [round(shell("ls")), round(shell("ls")), round(text("No files."))],
    );
    // The user's Computer exists and sleeps, then its sandbox is lost: its next wake rebuilds it.
    await deps.plugin("computer").forUser(user.id).run("true");
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);

    await send(client, botId, "what's on the computer?");
    await settled(botId);

    const shellResults = (call: TextOptions | undefined) =>
      inputOf(call)
        .filter((entry) => entry.role === "tool")
        .map((entry) => JSON.parse(String(entry.content)));
    // The Helper hears of it in its first result only.
    expect(shellResults(helperFake.calls[2]).map((result) => "note" in result)).toEqual([
      true,
      false,
    ]);
    // The Bot's own next Computer call still carries the note: the Helper's doesn't count for it.
    expect(shellResults(turnFake.calls[2]).at(-1)).toHaveProperty("note");
  });
});

describe("Stop and deletion", () => {
  it("leaves the Helpers running when the user stops the Turn", async () => {
    let shellStarted: () => void = () => {};
    const running = new Promise<void>((resolve) => (shellStarted = resolve));
    let finishShell: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finishShell = resolve));
    const { client, botId } = await botWith(
      [round(startHelper("Keep going."), shell("sleep 5")), round(text("Never comes."))],
      [round(text("Done."))],
      {
        manualHelpers: true,
        onCommand: async () => {
          shellStarted();
          await finished;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    const stream = await client.bot.send({ botId, id: uuidv7(), text: "go" });
    await running;
    await client.bot.stop({ botId });
    // The command's Checkpoint is the Turn's next write, which sees the cancel.
    finishShell();
    await expect
      .poll(async () => (await turnsOf(botId))[0]?.status, { timeout: 5_000 })
      .toBe("stopped");
    await stream.return?.(undefined);

    expect((await helpersOf(botId)).map((row) => row.status)).toEqual(["running"]);
  });

  it("leaves no Helper rows or queued Helper jobs once the user is deleted", async () => {
    const { client, botId, deps, user } = await botWith(
      [round(startHelper("One."), startHelper("Two."), sends({ text: "On it.", endTurn: true }))],
      [round(text("Never comes.")), round(text("Never comes."))],
      { manualHelpers: true },
    );
    await send(client, botId, "go");
    expect(await helpersOf(botId)).toHaveLength(2);

    await deleteUserData(deps, user.id);

    expect(await getTestDb().select().from(botHelper)).toEqual([]);
    const helperJobs = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(eq(job.name, "bot.helper"));
    expect(helperJobs.filter((row) => row.status === "queued" || row.status === "running")).toEqual(
      [],
    );
  });
});

describe("the Conversation's Helpers (#590)", () => {
  it("lists a live Helper with its Steps and latest tool call, then its report once it ends", async () => {
    // The Helper's shell command waits until the test lets it through.
    let finishCommand: (() => void) | undefined;
    const commandHeld = new Promise<void>((resolve) => (finishCommand = resolve));
    const { client, botId } = await botWith(
      [handsOff("Count the files in /home/user/shared.\nThen report."), round()],
      [round(shell("ls /home/user/shared | wc -l")), round(text("There are 3 files."))],
      {
        onCommand: async () => {
          await commandHeld;
          return { exitCode: 0, stdout: "3\n", stderr: "" };
        },
      },
    );
    await send(client, botId, "how many files are there?");

    await expect
      .poll(async () => (await client.bot.helper.list({ botId }))[0]?.latest, { timeout: 10_000 })
      .toBe("shell: ls /home/user/shared | wc -l");
    const { messages } = await client.bot.get({ botId });
    const [live] = await client.bot.helper.list({ botId });
    expect(live).toMatchObject({
      type: "general",
      task: "Count the files in /home/user/shared.\nThen report.",
      gist: "Count the files in /home/user/shared.",
      status: "running",
      steps: 1,
      report: null,
      afterMessageId: messages.find((message) => message.role === "assistant")?.id,
    });

    finishCommand!();
    await settled(botId);
    const [ended] = await client.bot.helper.list({ botId });
    expect(ended).toMatchObject({
      status: "complete",
      steps: 2,
      latest: null,
      report: "There are 3 files.",
    });
  });

  it("is empty for a Bot with no Helpers, and a Bot of another user is not found", async () => {
    const { client, botId } = await botWith([], []);
    expect(await client.bot.helper.list({ botId })).toEqual([]);

    const other = chatRpc({ user: await insertUser(), deps: (await botWith([], [])).deps });
    await expect(other.bot.helper.list({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
