import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it } from "vitest";

import {
  botHelper,
  botHelperMessage,
  botSecret,
  botTrigger,
  botTurn,
  computer as computerTable,
  job,
  jobEvent,
  usage,
  relations,
} from "../../../../core/server/storage";
import type { Database } from "../../../../core/server/storage";

import { encryptCredentials } from "../../../../core/server/credentials/encryption";
import { deleteUserData } from "../../../../core/server/user-data";
import type { HostProvider } from "../../../../plugins/models/server/internal";
import {
  botHelperJob,
  computerUseModelError,
  computerUseOnPlanError,
  generalHelperPrompt,
  helperEndings,
  helperQuotaSpentError,
  helperStepLimit,
  helperTimeLimitMs,
  tooManyGeneralHelpersError,
  listHelpers,
} from "../../../../plugins/bot/server/helpers";
import { secretEncryption } from "../../../../plugins/bot/server/safety";

import type { CommandResult } from "../../../../plugins/computer/server/internal";
import { saveCredentials, quotaLookup } from "../../../../plugins/models/server/internal";

import {
  inProcessRunner,
  type JobRunner,
  claimJob,
  reapStaleJobs,
} from "../../../../plugins/runner/server/internal";

import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall, withUsage } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { fakeComputerProvider, type FakeCommandRun } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The runners the tests started, stopped after each test. */
const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

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
    linked = false,
    provider = "openai",
    ...overrides
  }: {
    withComputer?: boolean;
    manualHelpers?: boolean;
    /** The Provider whose key the user has; the Bot is on its Model. */
    provider?: "openai" | "gemini";
    /** The Bot is on a ChatGPT plan Model and the user has a linked plan, not a key (ADR 0023). */
    linked?: boolean;
    onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
  } & Pick<TestDepsOverrides, "clock" | "getQuota" | "hostProviders"> = {},
) {
  const fakes = splitAdapter(turns, helpers, manualHelpers);
  const computerFake = fakeComputerProvider({ onCommand });
  let deps: TestDeps | undefined;
  const adapterCredentials: Array<Record<string, string>> = [];
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    ...(withComputer && { computer: computerFake.provider }),
    jobs,
    adapterFor: (_model, credentials) => {
      adapterCredentials.push(credentials);
      return fakes.adapter;
    },
    ...(linked && { linkedCredentials: async () => planCredentials }),
    // No memory pass takes a Turn's round.
    memory: false,
    ...overrides,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!overrides.hostProviders && !linked) {
    await saveCredentials(deps, user.id, {
      service: provider,
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({
    name: "Ada",
    model: overrides.hostProviders
      ? hostModel
      : linked
        ? planModel
        : provider === "gemini"
          ? "gemini:gemini-3.8-flash"
          : model,
  });
  return { ...fakes, adapterCredentials, computerFake, deps, client, user, botId: created.id };
}

const hostModel = "anthropic:claude-sonnet-5-5";
const planModel = "openai:gpt-6.1-sol";
const planCredentials = { apiKey: "chatgpt-access-token" };

/** Sends `text` to the Bot and reads the whole stream. */
async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  const events = [];
  for await (const event of await followSend(client, { botId, id: uuidv7(), text })) {
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
      "web_search",
    ]);
    expect(inputOf(helperFake.calls[0])).toEqual([
      { role: "user", content: "Count the files in /home/user/shared." },
    ]);
    expect(computerFake.callsOf("run").map((call) => call.command)).toEqual([
      "ls /home/user/shared | wc -l",
    ]);
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "complete", report: "There are 3 files." });
    // The Helper's calls run on its own thread; the Turns' on their Bot's.
    expect(helperFake.calls.map((call) => call.threadId)).toEqual([helper?.id, helper?.id]);
    expect(turnFake.calls.every((call) => call.threadId === botId)).toBe(true);
    expect(helper?.endedAt).toBeInstanceOf(Date);
    const [trigger] = await helperTriggers();
    expect(trigger).toMatchObject({
      id: `helper:${helper?.id}`,
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

  it("gives a General Helper's command the Secrets it names, and masks them in its result", async () => {
    const token = "ghp_s3cr3t-Value+/=42";
    const { client, botId, helperFake, deps, user, computerFake } = await botWith(
      [handsOff("Check my login."), round(sends({ text: "Checked.", endTurn: true }))],
      [
        round(
          toolCall({ name: "shell", input: { command: "gh auth status", secrets: ["GH_TOKEN"] } }),
        ),
        round(text("Logged in.")),
      ],
      { onCommand: ({ envs }) => ({ exitCode: 0, stdout: `token ${envs?.GH_TOKEN}`, stderr: "" }) },
    );
    await getTestDb()
      .insert(botSecret)
      .values({
        userId: user.id,
        name: "GH_TOKEN",
        encrypted: encryptCredentials(
          { value: token },
          secretEncryption(deps, user.id, "GH_TOKEN"),
        ),
        createdAt: new Date(),
      });

    await send(client, botId, "check my login");
    await settled(botId);

    const [run] = computerFake.callsOf("run").filter((call) => call.command === "gh auth status");
    expect(run?.envs).toEqual({ GH_TOKEN: token });
    const result = inputOf(helperFake.calls[1]).findLast((entry) => entry.role === "tool");
    expect(JSON.parse(String(result?.content)).stdout).toBe("token ***");
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
    await botHelperJob.onFailed!({ helperId: helper!.id }, new Error("again"), { deps });

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
      drainMs: 1_000,
      jobs: () => deps!.parts.jobs,
    });
    started.push(jobs);
    deps = createTestSdk({
      computer: fakeComputerProvider().provider,
      jobs,
      adapterFor: () => fakes.adapter,
      memory: false,
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
      return jobs.runClaimed(claimed);
    };
    await followSend(client, { botId, id: uuidv7(), text: "go" });
    // The Turn's job: it starts the Helper and ends.
    await attempt();

    const lost = [attempt()];
    for (const calls of [1, 2, 3]) {
      // Each attempt waits in the Helper's first model call when its process stops.
      await expect.poll(() => fakes.helperFake.calls.length).toBe(calls);
      timer.advance(61_000);
      await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps.parts.jobs);
      timer.tick();
      if (calls < 3) lost.push(attempt());
    }
    await Promise.all(lost);

    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "error", report: helperEndings.crashed });
    const [trigger] = await helperTriggers();
    expect(trigger?.id).toBe(`helper:${helper?.id}`);
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
    const [helper] = await helpersOf(botId);
    const sourceId = helper!.id;
    expect(rows).toMatchObject([
      { kind: "helper", model: hostModel, inputTokens: 100, outputTokens: 10, sourceId },
      { kind: "helper", model: hostModel, inputTokens: 100, outputTokens: 10, sourceId },
    ]);
    expect(helper?.usage).toMatchObject({ input: 200, output: 20 });
  });

  it("runs on the user's linked ChatGPT plan, with usage rows at cost 0, when the Bot is on a plan Model (ADR 0023)", async () => {
    const { client, botId, user, helperFake, adapterCredentials } = await botWith(
      [handsOff("Count."), round()],
      [round(shell("true")), round(text("Done."))],
      { linked: true },
    );

    await send(client, botId, "go");
    await settled(botId);

    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "complete", report: "Done." });
    expect(helperFake.calls).toHaveLength(2);
    expect(new Set(adapterCredentials.map((credentials) => credentials.apiKey))).toEqual(
      new Set([planCredentials.apiKey]),
    );
    const planRows = await usageOf(user.id);
    expect(planRows.filter((row) => row.kind === "helper")).toHaveLength(2);
    expect(planRows.every((row) => row.costMicros === 0)).toBe(true);
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

describe("starting a Computer-use Helper on a Model", () => {
  const startComputerUse = () =>
    toolCall({ name: "start_helper", input: { type: "computer_use", task: "Open the page." } });

  it("refuses on a Model without computerUse, with a next step, and a General Helper still starts", async () => {
    const { client, botId, turnFake } = await botWith(
      [
        round(startComputerUse()),
        round(startHelper("Count.")),
        round(sends({ text: "Can't.", endTurn: true })),
      ],
      [round(text("Done."))],
      { provider: "gemini" },
    );

    await send(client, botId, "browse");

    expect(resultInTranscript(inputOf(turnFake.calls[1]), "start_helper")).toEqual({
      error: computerUseModelError,
    });
    await settled(botId);
    expect((await helpersOf(botId)).map((row) => row.type)).toEqual(["general"]);
  });

  it("refuses on a linked ChatGPT plan, which rejects the native computer tool", async () => {
    const { client, botId, turnFake } = await botWith(
      [
        round(startComputerUse()),
        round(startHelper("Count.")),
        round(sends({ text: "Can't.", endTurn: true })),
      ],
      [round(text("Done."))],
      { linked: true },
    );

    await send(client, botId, "browse");

    expect(resultInTranscript(inputOf(turnFake.calls[1]), "start_helper")).toEqual({
      error: computerUseOnPlanError,
    });
    await settled(botId);
    expect((await helpersOf(botId)).map((row) => row.type)).toEqual(["general"]);
  });

  it("starts on a Model with computerUse", async () => {
    const { client, botId } = await botWith(
      [round(startComputerUse(), sends({ text: "On it.", endTurn: true }))],
      [round(text("Done."))],
      { manualHelpers: true },
    );

    await send(client, botId, "browse");

    expect(await helpersOf(botId)).toMatchObject([{ type: "computer_use", status: "running" }]);
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
    await deps.computer!.forUser(user.id).run("true");
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

    const stream = await followSend(client, { botId, id: uuidv7(), text: "go" });
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

  it("stops the user's running Helpers on a Ban, cancelling their jobs, and no report comes", async () => {
    const { client, botId, deps, user } = await botWith(
      [round(startHelper("One."), sends({ text: "On it.", endTurn: true }))],
      [round(text("Never comes."))],
      { manualHelpers: true },
    );
    await send(client, botId, "go");

    await deps.bots.stopTurns({ userId: user.id });

    expect((await helpersOf(botId)).map((row) => row.status)).toEqual(["stopped"]);
    const helperJobs = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(eq(job.name, "bot.helper"));
    expect(helperJobs.map((row) => row.status)).toEqual(["cancelled"]);
    expect(await helperTriggers()).toEqual([]);
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

  it("reads the list in the same few queries however many Helpers are live", async () => {
    const { client, botId } = await botWith(
      [
        round(
          startHelper("One."),
          startHelper("Two."),
          startHelper("Three."),
          sends({ text: "On it.", endTurn: true }),
        ),
      ],
      [round(text("Never comes.")), round(text("Never comes.")), round(text("Never comes."))],
      { manualHelpers: true },
    );
    await send(client, botId, "go");
    const queries: string[] = [];
    const counted = drizzle({
      client: getTestDb().$client,
      relations,
      logger: { logQuery: (query) => queries.push(query) },
    }) as unknown as Database;

    const helpers = await listHelpers(counted, botId);

    expect(helpers.map((helper) => helper.status)).toEqual(["running", "running", "running"]);
    expect(queries).toHaveLength(3);
  });

  it("is empty for a Bot with no Helpers, and a Bot of another user is not found", async () => {
    const { client, botId } = await botWith([], []);
    expect(await client.bot.helper.list({ botId })).toEqual([]);

    const other = chatRpc({ user: await insertUser(), deps: (await botWith([], [])).deps });
    await expect(other.bot.helper.list({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
/** Commands that each wait until the test lets them through, in order. */
function heldCommands() {
  const releases: Array<() => void> = [];
  let started = 0;
  const onCommand = async () => {
    started += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  };
  return {
    onCommand,
    /** Waits until `count` commands have started. */
    started: (count: number) => expect.poll(() => started, { timeout: 10_000 }).toBe(count),
    /** Lets the oldest held command finish. */
    release: () => releases.shift()?.(),
  };
}

const checkHelper = (helperId: string) => toolCall({ name: "check_helper", input: { helperId } });

const messageHelper = (helperId: string, text: string) =>
  toolCall({ name: "message_helper", input: { helperId, text } });

const stopHelpers = (helperId?: string) =>
  toolCall({ name: "stop_helpers", input: helperId ? { helperId } : {} });

/** The results of every tool call `name` in a transcript, parsed, in order. */
const resultsOf = (transcript: ModelMessage[] | null | undefined, name: string) => {
  const entries = transcript ?? [];
  return entries
    .flatMap((entry) => entry.toolCalls ?? [])
    .filter((call) => call.function.name === name)
    .map((call) =>
      JSON.parse(String(entries.find((entry) => entry.toolCallId === call.id)?.content)),
    );
};

/** How many of `input`'s user turns hold `needle`. */
const userTurnsWith = (input: ModelMessage[], needle: string) =>
  input.filter((entry) => entry.role === "user" && JSON.stringify(entry.content).includes(needle))
    .length;

const noHelperError = "No Helper with that id; your to-do list shows the current ones.";
const finishedError = "That Helper already finished. Read its report, or start a new one.";

describe("checking on a Helper (#591)", () => {
  it("returns its status, task, Steps and latest tool call, then its report once it ended", async () => {
    const ids: string[] = [];
    const held = heldCommands();
    const { client, botId } = await botWith(
      [
        handsOff("Count the files in /home/user/shared."),
        () => round(checkHelper(ids[0]!), sends({ text: "Still counting.", endTurn: true })),
        () => round(checkHelper(ids[0]!), sends({ text: "3 files.", endTurn: true })),
      ],
      [round(shell("ls /home/user/shared | wc -l")), round(text("There are 3 files."))],
      { onCommand: held.onCommand },
    );
    await send(client, botId, "how many files?");
    ids.push((await helpersOf(botId))[0]!.id);
    await held.started(1);

    await send(client, botId, "how's it going?");

    expect(resultsOf((await turnsOf(botId))[1]?.transcript, "check_helper")).toEqual([
      {
        status: "running",
        task: "Count the files in /home/user/shared.",
        steps: 1,
        latest: "shell: ls /home/user/shared | wc -l",
        report: null,
      },
    ]);

    held.release();
    await settled(botId);
    expect(resultsOf((await turnsOf(botId))[2]?.transcript, "check_helper")).toEqual([
      {
        status: "complete",
        task: "Count the files in /home/user/shared.",
        steps: 2,
        latest: null,
        report: "There are 3 files.",
      },
    ]);
  });

  it("refuses an unknown id, and another Bot's Helper, with a next step", async () => {
    const other = await botWith([handsOff("Elsewhere.")], [round(text("Never comes."))], {
      manualHelpers: true,
    });
    await send(other.client, other.botId, "go");
    const [elsewhere] = await helpersOf(other.botId);
    const { client, botId } = await botWith(
      [
        round(
          checkHelper(uuidv7()),
          checkHelper("h_3f2a"),
          checkHelper(elsewhere!.id),
          messageHelper(elsewhere!.id, "Hi."),
          stopHelpers(elsewhere!.id),
          sends({ text: "None.", endTurn: true }),
        ),
      ],
      [],
    );

    await send(client, botId, "go");

    const [turn] = await turnsOf(botId);
    const errors = (turn?.transcript ?? [])
      .filter((entry) => entry.role === "tool")
      .slice(0, 5)
      .map((entry) => JSON.parse(String(entry.content)));
    expect(errors).toEqual(Array.from({ length: 5 }, () => ({ error: noHelperError })));
    expect((await helpersOf(other.botId))[0]?.status).toBe("running");
    expect(await getTestDb().select().from(botHelperMessage)).toEqual([]);
  });
});

describe("a long check_helper result (#665)", () => {
  it("is saved on the Computer after its Checkpoint commits, not inside its transaction", async () => {
    const ids: string[] = [];
    const task = `Count every file. ${"x".repeat(12_000)}`;
    const { client, botId, computerFake } = await botWith(
      [
        handsOff(task),
        () => round(checkHelper(ids[0]!), sends({ text: "Still counting.", endTurn: true })),
      ],
      [],
      { manualHelpers: true },
    );
    await send(client, botId, "count them");
    ids.push((await helpersOf(botId))[0]!.id);
    // At each spill, whether check_helper's Checkpoint was already committed.
    const committedAtSpill: boolean[] = [];
    const writeFile = computerFake.provider.writeFile;
    computerFake.provider.writeFile = async (sandboxId, path, content) => {
      if (path.includes("/.outputs/")) {
        const saved = await getTestDb()
          .select({ name: jobEvent.name })
          .from(jobEvent)
          .where(eq(jobEvent.name, "check_helper"));
        committedAtSpill.push(saved.length > 0);
      }
      return writeFile(sandboxId, path, content);
    };

    await send(client, botId, "how is it going?");

    expect(committedAtSpill).toEqual([true]);
    const [, turn] = await turnsOf(botId);
    const result = (turn?.transcript ?? []).find((entry) => entry.role === "tool");
    expect(String(result?.content)).toMatch(/The full text is saved at .*.outputs/);
  });
});

describe("messaging a Helper (#591)", () => {
  it("reaches the Helper's next model input once, and a replay reads the same", async () => {
    const ids: string[] = [];
    const held = heldCommands();
    const { client, botId, deps, helperFake } = await botWith(
      [
        handsOff("Count the files."),
        () =>
          round(
            messageHelper(ids[0]!, "Count hidden files too."),
            sends({ text: "Told it.", endTurn: true }),
          ),
      ],
      [round(shell("ls")), round(shell("ls -a")), round(text("Never comes."))],
      { onCommand: held.onCommand },
    );
    await send(client, botId, "count the files");
    ids.push((await helpersOf(botId))[0]!.id);
    await held.started(1);

    await send(client, botId, "hidden ones too");
    expect(resultsOf((await turnsOf(botId))[1]?.transcript, "message_helper")).toEqual([
      { sent: true },
    ]);
    expect(userTurnsWith(inputOf(helperFake.calls[0]), "Count hidden files too.")).toBe(0);

    held.release();
    await held.started(2);
    const message = "Message from your Bot: Count hidden files too.";
    expect(helperFake.calls).toHaveLength(2);
    expect(userTurnsWith(inputOf(helperFake.calls[1]), message)).toBe(1);
    const [row] = await getTestDb()
      .select()
      .from(botHelperMessage)
      .where(eq(botHelperMessage.helperId, ids[0]!));
    expect(row).toMatchObject({ text: "Count hidden files too." });
    expect(row?.deliveredAt).toBeInstanceOf(Date);

    // The job's last-chance ending replays its Checkpoints: the inbox reads the recorded message,
    // though the row now reads delivered.
    await botHelperJob.onFailed!({ helperId: ids[0]! }, new Error("lost"), { deps });
    const [helper] = await helpersOf(botId);
    expect(helper?.status).toBe("error");
    expect(userTurnsWith(helper?.transcript ?? [], message)).toBe(1);
    held.release();
  });

  it("refuses a message to a Helper that already finished", async () => {
    const ids: string[] = [];
    const { client, botId } = await botWith(
      [
        handsOff("Say hi."),
        round(),
        () => round(messageHelper(ids[0]!, "And bye."), sends({ text: "Done.", endTurn: true })),
      ],
      [round(text("hi"))],
    );
    await send(client, botId, "go");
    await settled(botId);
    ids.push((await helpersOf(botId))[0]!.id);

    await send(client, botId, "tell it bye");

    expect(resultsOf((await turnsOf(botId)).at(-1)?.transcript, "message_helper")).toEqual([
      { error: finishedError },
    ]);
    expect(await getTestDb().select().from(botHelperMessage)).toEqual([]);
  });
});

describe("stopping Helpers (#591)", () => {
  it("stops one, then all, cancelling their jobs and sending no Trigger", async () => {
    const ids: string[] = [];
    const { client, botId } = await botWith(
      [
        round(startHelper("One."), startHelper("Two."), sends({ text: "On it.", endTurn: true })),
        () => round(stopHelpers(ids[0]!), sends({ text: "Stopped one.", endTurn: true })),
        () => round(stopHelpers(), sends({ text: "Stopped all.", endTurn: true })),
      ],
      [round(text("Never comes.")), round(text("Never comes."))],
      { manualHelpers: true },
    );
    await send(client, botId, "go");
    ids.push(...(await helpersOf(botId)).map((row) => row.id));

    await send(client, botId, "stop the first");
    expect(resultsOf((await turnsOf(botId))[1]?.transcript, "stop_helpers")).toEqual([
      { stopped: [ids[0]] },
    ]);
    expect((await helpersOf(botId)).map((row) => row.status)).toEqual(["stopped", "running"]);

    await send(client, botId, "stop them all");
    expect(resultsOf((await turnsOf(botId))[2]?.transcript, "stop_helpers")).toEqual([
      { stopped: [ids[1]] },
    ]);
    const helpers = await helpersOf(botId);
    expect(helpers.map((row) => row.status)).toEqual(["stopped", "stopped"]);
    expect(helpers.every((row) => row.endedAt instanceof Date)).toBe(true);
    // What their Checkpoints hold, written by a job once the stop committed: nothing past the
    // task, since neither model call finished.
    await expect
      .poll(async () => (await helpersOf(botId)).map((row) => row.transcript), { timeout: 10_000 })
      .toEqual([[{ role: "user", content: "One." }], [{ role: "user", content: "Two." }]]);
    const jobs = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(eq(job.name, "bot.helper"));
    expect(jobs.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect(await helperTriggers()).toEqual([]);
  });

  it("refuses to stop a Helper that already finished", async () => {
    const ids: string[] = [];
    const { client, botId } = await botWith(
      [
        handsOff("Say hi."),
        round(),
        () => round(stopHelpers(ids[0]!), sends({ text: "Done.", endTurn: true })),
      ],
      [round(text("hi"))],
    );
    await send(client, botId, "go");
    await settled(botId);
    ids.push((await helpersOf(botId))[0]!.id);

    await send(client, botId, "stop it");

    expect(resultsOf((await turnsOf(botId)).at(-1)?.transcript, "stop_helpers")).toEqual([
      { error: finishedError },
    ]);
    expect((await helpersOf(botId))[0]?.status).toBe("complete");
  });

  it("lets the user stop one Helper or all of them, and not another user's", async () => {
    const { client, botId, deps } = await botWith(
      [
        round(
          startHelper("One."),
          startHelper("Two."),
          startHelper("Three."),
          sends({ text: "On it.", endTurn: true }),
        ),
      ],
      [round(text("Never comes.")), round(text("Never comes.")), round(text("Never comes."))],
      { manualHelpers: true },
    );
    await send(client, botId, "go");
    const [one] = await helpersOf(botId);

    const stranger = chatRpc({ user: await insertUser(), deps });
    await expect(stranger.bot.helper.stop({ botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await client.bot.helper.stop({ botId, helperId: one!.id });
    expect((await client.bot.helper.list({ botId })).map((helper) => helper.status)).toEqual([
      "stopped",
      "running",
      "running",
    ]);
    await client.bot.helper.stop({ botId });
    expect((await client.bot.helper.list({ botId })).map((helper) => helper.status)).toEqual([
      "stopped",
      "stopped",
      "stopped",
    ]);
    expect(await helperTriggers()).toEqual([]);
  });
});

describe("the to-do list (#591)", () => {
  it("is a line per live Helper in the Turn's newest input, nothing when none, and the system prompt is unchanged", async () => {
    const held = heldCommands();
    const { client, botId, turnFake } = await botWith(
      [
        handsOff("Count the files in /home/user/shared.\nThen report."),
        round(sends({ text: "Working on it.", endTurn: true })),
        round(sends({ text: "Done.", endTurn: true })),
      ],
      [round(shell("ls")), round(text("There are 3 files."))],
      { onCommand: held.onCommand },
    );

    await send(client, botId, "how many files?");
    expect(JSON.stringify(inputOf(turnFake.calls[0]))).not.toContain("to-do");
    const [helper] = await helpersOf(botId);
    await held.started(1);

    await send(client, botId, "how's it going?");
    const since = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(helper!.startedAt);
    const newest = inputOf(turnFake.calls[1]).at(-1);
    expect(newest?.role).toBe("user");
    const lines = String(newest?.content).split("\n");
    expect(lines).toContain(
      `${helper!.id} · General · running: Count the files in /home/user/shared. · since ${since}`,
    );
    expect(lines.at(-1)).toBe("how's it going?");
    expect(turnFake.calls[1]?.systemPrompts).toEqual(turnFake.calls[0]?.systemPrompts);

    held.release();
    await settled(botId);
    // The report's Turn: the Helper has ended, so the list is gone.
    expect(String(inputOf(turnFake.calls[2]).at(-1)?.content)).not.toContain(helper!.id);
  });
});
