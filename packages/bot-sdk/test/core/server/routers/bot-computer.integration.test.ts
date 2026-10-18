import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { computer as computerTable } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { botSystemPrompt } from "../../../../plugins/bot/server/turn";
import { computer } from "../../../../plugins/computer/server/plugin";
import type { CommandResult } from "../../../../plugins/computer/server/provider";
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
import {
  fakeComputerProvider,
  type FakeCommand,
} from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The runners the tests started, stopped after each test. */
const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/**
 * A user with an OpenAI key and a Bot, over an SDK whose Model plays `rounds` and whose in-process
 * runner runs the Turns. With `withComputer`, `computer` is on over a fake provider whose commands
 * `onCommand` answers.
 */
async function botWith(
  rounds: Round[],
  {
    withComputer = true,
    onCommand,
  }: {
    withComputer?: boolean;
    onCommand?: (command: FakeCommand) => CommandResult | Promise<CommandResult>;
  } = {},
) {
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider({ onCommand });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    plugins: withComputer ? [bot(), computer({ provider: computerFake.provider })] : [bot()],
    jobs,
    adapterFor: () => fake.adapter,
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
  const created = await client.bot.create({ name: "Ada", model });
  return { fake, computerFake, deps, client, user, botId: created.id };
}

/** Sends `text` to the Bot and reads the whole stream. */
async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  const events = [];
  for await (const event of await client.bot.send({ botId, id: uuidv7(), text })) {
    events.push(event);
  }
  return events;
}

const shell = (input: { command: string; cwd?: string }) => toolCall({ name: "shell", input });

/** The model input of one call: its messages, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The result the Model got for its tool call in call `call`, parsed. */
const toolResultOf = (call: TextOptions | undefined) =>
  JSON.parse(String(inputOf(call).find((entry) => entry.role === "tool")?.content));

/** The names of the tools a model call offered. */
const toolNamesOf = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

const computerRow = async (userId: string) =>
  (await getTestDb().select().from(computerTable).where(eq(computerTable.userId, userId)))[0];

describe("the shell tool", () => {
  it("runs a command on the user's Computer and hands the Model its exit code and output", async () => {
    const { client, botId, fake, computerFake } = await botWith(
      [round(shell({ command: "echo hi; exit 3" })), round()],
      { onCommand: () => ({ exitCode: 3, stdout: "hi\n", stderr: "oops\n" }) },
    );

    const events = await send(client, botId, "run it");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    // A non-zero exit is a normal result.
    expect(toolResultOf(fake.calls[1])).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "oops\n" });
    expect(computerFake.callsOf("create")).toHaveLength(1);
    expect(computerFake.callsOf("run").map((call) => call.command)).toEqual(["echo hi; exit 3"]);
  });

  it("reuses the Computer in the next Turn, with no second create", async () => {
    const { client, botId, computerFake, user } = await botWith([
      round(shell({ command: "echo one" })),
      round(),
      round(shell({ command: "echo two" })),
      round(),
    ]);

    await send(client, botId, "first");
    await send(client, botId, "second");

    expect(computerFake.callsOf("create")).toHaveLength(1);
    const runs = computerFake.callsOf("run");
    expect(runs.map((call) => call.command)).toEqual(["echo one", "echo two"]);
    expect(runs[1]?.sandboxId).toBe(runs[0]?.sandboxId);
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: runs[0]?.sandboxId,
    });
  });

  it("resumes a Computer whose row is asleep, and the row becomes awake", async () => {
    const { client, botId, computerFake, user } = await botWith([
      round(shell({ command: "echo one" })),
      round(),
      round(shell({ command: "echo two" })),
      round(),
    ]);
    await send(client, botId, "first");
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));

    await send(client, botId, "second");

    const [created] = computerFake.callsOf("create");
    expect(computerFake.callsOf("create")).toHaveLength(1);
    expect(computerFake.callsOf("resume")).toEqual([
      // With the backstop: the sandbox pauses itself an hour on, should no sleep check run.
      { type: "resume", sandboxId: created?.sandboxId, timeoutMs: 60 * 60_000 },
    ]);
    // The resume comes before the command that needed it.
    expect(computerFake.calls.map((call) => call.type)).toEqual(["create", "run", "resume", "run"]);
    expect(await computerRow(user.id)).toMatchObject({ state: "awake" });
  });

  it("runs in the Bot's directory by default, and honours cwd", async () => {
    const { client, botId, computerFake } = await botWith([
      round(
        shell({ command: "pwd" }),
        shell({ command: "ls", cwd: "notes" }),
        shell({ command: "ls", cwd: "/home/user/shared" }),
      ),
      round(),
    ]);

    await send(client, botId, "where are you?");

    expect(computerFake.callsOf("run").map((call) => call.cwd)).toEqual([
      `/home/user/bots/${botId}`,
      `/home/user/bots/${botId}/notes`,
      "/home/user/shared",
    ]);
  });

  it("names the Bot's directory and the shared one in the system prompt", async () => {
    const { client, botId, fake } = await botWith([round()]);

    await send(client, botId, "hi");

    expect(toolNamesOf(fake.calls[0])).toEqual(["send_to_user", "shell"]);
    const prompt = JSON.stringify(fake.calls[0]?.systemPrompts);
    expect(prompt).toContain(`/home/user/bots/${botId}`);
    expect(prompt).toContain("/home/user/shared");
    expect(prompt).not.toContain("It is your only tool");
  });

  it("has no Computer tools and no mention of them when computer is off", async () => {
    const { client, botId, fake, user } = await botWith([round()], { withComputer: false });

    await send(client, botId, "hi");

    expect(toolNamesOf(fake.calls[0])).toEqual(["send_to_user"]);
    expect(fake.calls[0]?.systemPrompts).toEqual([botSystemPrompt]);
    expect(JSON.stringify(fake.calls[0]?.systemPrompts)).not.toMatch(
      /computer|shell|\/home\/user/i,
    );
    expect(await computerRow(user.id)).toBeUndefined();
  });
});

describe("a user's Computer", () => {
  it("is created on its first operation, not before", async () => {
    const { client, botId, user } = await botWith([round()]);

    await send(client, botId, "hi");

    // A Turn that used no Computer tool leaves the Computer alone.
    expect(await computerRow(user.id)).toBeUndefined();
  });
});
