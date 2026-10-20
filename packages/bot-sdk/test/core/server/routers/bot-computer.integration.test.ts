import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bot as botTable,
  botTurn,
  computer as computerTable,
  job,
} from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import { maxTextBytes } from "../../../../plugins/bot/server/computer-tools";
import { bot } from "../../../../plugins/bot/server/plugin";
import {
  computerUnavailableError,
  interruptedShellError,
  rebuiltNote,
} from "../../../../plugins/bot/server/computer-tools";
import { turnTimeLimitMs } from "../../../../plugins/bot/server/store";
import { botSystemPrompt } from "../../../../plugins/bot/server/turn";
import { computer } from "../../../../plugins/computer/server/plugin";
import type { CommandResult } from "../../../../plugins/computer/server/provider";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob, reapStaleJobs } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { drainJobs, fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
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

/**
 * A user with an OpenAI key and a Bot, over an SDK whose Model plays `rounds` and whose in-process
 * runner runs the Turns. With `withComputer`, `computer` is on over a fake provider whose commands
 * `onCommand` answers. `memory` is installed only `withMemory`, so no memory pass takes a round.
 */
async function botWith(
  rounds: Round[],
  {
    withComputer = true,
    withMemory = false,
    onCommand,
    clock,
  }: {
    withComputer?: boolean;
    withMemory?: boolean;
    clock?: () => Date;
    onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
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
    memory: withMemory,
    ...(clock ? { clock } : {}),
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

const shell = (input: { command: string; cwd?: string; timeoutSeconds?: number }) =>
  toolCall({ name: "shell", input });

const sends = (input: { text: string; endTurn: boolean }) =>
  toolCall({ name: "send_to_user", input });

/** The Bot's Turn (each test sends it at most one that matters here). */
const turnOf = async (botId: string) =>
  (await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId)))[0];

/** The model input of one call: its messages, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The result the Model got for the last tool call in its input to call `call`, parsed. */
const toolResultOf = (call: TextOptions | undefined) =>
  JSON.parse(String(inputOf(call).findLast((entry) => entry.role === "tool")?.content));

/** The names of the tools a model call offered. */
const toolNamesOf = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

/** The Bot's tools with no Computer: SendToUser, then the Routine and Check-in tools (spec #543). */
const botTools = [
  "send_to_user",
  "create_routine",
  "update_routine",
  "delete_routine",
  "set_check_in",
  "cancel_check_in",
  "list_check_ins",
  "web_search",
];

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
    const { client, botId, fake } = await botWith([round()], { withMemory: true });

    await send(client, botId, "hi");

    expect(toolNamesOf(fake.calls[0])).toEqual(
      [
        ...botTools,
        "search_memory",
        "shell",
        "read",
        "write",
        "edit",
        "list",
        "start_helper",
        "check_helper",
        "message_helper",
        "stop_helpers",
      ].sort(),
    );
    const prompt = JSON.stringify(fake.calls[0]?.systemPrompts);
    expect(prompt).toContain(`/home/user/bots/${botId}`);
    expect(prompt).toContain("/home/user/shared");
    expect(prompt).not.toContain("It is your only tool");
  });

  it("puts the cheapest-first ladder in the system prompt, ahead of the conversation (#598)", async () => {
    const { client, botId, fake } = await botWith([round()]);

    await send(client, botId, "hi");

    const prompts = (fake.calls[0]?.systemPrompts ?? []).map(String);
    const ladder = prompts.find((prompt) => prompt.startsWith("You have a computer"));
    expect(ladder).toContain(
      "Try the cheapest way first: what you already know or have in your files, then `web_search`, then a Helper.",
    );
    expect(ladder).toContain("Hand anything bigger to a Helper with `start_helper`");
    expect(ladder).toContain(
      "Write the task so it stands alone, since the Helper sees nothing else.",
    );
    expect(ladder).toContain("never work around it with a browser.");
  });

  it("offers the same tools in every Turn, whether or not a Helper is running (#598)", async () => {
    const { client, botId, fake } = await botWith([
      round(toolCall({ name: "start_helper", input: { type: "general", task: "Look it up." } })),
      round(),
      round(),
    ]);

    await send(client, botId, "first");
    await send(client, botId, "second");

    // The Helper's own model calls share the fake; the Bot's are the ones without its prompt.
    const turnCalls = fake.calls.filter(
      (call) =>
        !(call.systemPrompts ?? []).some((prompt) => String(prompt).startsWith("You are a Helper")),
    );
    const names = turnCalls.map(toolNamesOf);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const turnNames of names) expect(turnNames).toEqual(names[0]);
    expect(names[0]).toContain("start_helper");
  });

  it("has no Computer tools and no mention of them when computer is off", async () => {
    const { client, botId, fake, user } = await botWith([round()], { withComputer: false });

    await send(client, botId, "hi");

    expect(toolNamesOf(fake.calls[0])).toEqual([...botTools].sort());
    expect(fake.calls[0]?.systemPrompts).toEqual([botSystemPrompt]);
    expect(JSON.stringify(fake.calls[0]?.systemPrompts)).not.toMatch(
      /computer|shell|\/home\/user/i,
    );
    expect(await computerRow(user.id)).toBeUndefined();
  });
});

/** A command that prints `printed`, then runs until it is killed. `started` resolves once it runs. */
function runsUntilKilled(printed = "") {
  let running: () => void = () => {};
  const started = new Promise<void>((resolve) => (running = resolve));
  const onCommand = ({ print, signal }: FakeCommandRun) => {
    print(printed);
    running();
    return new Promise<CommandResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("killed")));
    });
  };
  return { started, onCommand };
}

describe("shell at its limits", () => {
  it("kills a command that outlives timeoutSeconds and returns what it printed, timed out", async () => {
    const { client, botId, fake, computerFake } = await botWith(
      [round(shell({ command: "make all", timeoutSeconds: 0.05 })), round()],
      { onCommand: runsUntilKilled("building…\n").onCommand },
    );

    const events = await send(client, botId, "build it");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(toolResultOf(fake.calls[1])).toEqual({
      timedOut: true,
      stdout: "building…\n",
      stderr: "",
      hint: expect.stringMatching(/break .* up/i),
    });
    expect(computerFake.callsOf("run")[0]?.timeoutMs).toBe(50);
    expect(computerFake.callsOf("kill")).toEqual([
      {
        type: "kill",
        sandboxId: computerFake.callsOf("create")[0]?.sandboxId,
        command: "make all",
      },
    ]);
  });

  it("runs a command for 60 seconds by default, and caps a longer one at the Turn's time left", async () => {
    const { client, botId, computerFake } = await botWith([
      round(shell({ command: "echo quick" }), shell({ command: "sleep", timeoutSeconds: 3600 })),
      round(),
    ]);

    await send(client, botId, "go");

    const [quick, long] = computerFake.callsOf("run");
    expect(quick?.timeoutMs).toBe(60_000);
    expect(long?.timeoutMs).toBeLessThanOrEqual(turnTimeLimitMs);
    expect(long?.timeoutMs).toBeGreaterThan(turnTimeLimitMs - 30_000);
  });

  it("returns the couldn't-start note when the Computer fails to start, and the Turn carries on", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(shell({ command: "echo one" })),
      round(sends({ text: "My computer is down.", endTurn: true })),
    ]);
    computerFake.failing.add("create");

    const events = await send(client, botId, "run it");

    expect(toolResultOf(fake.calls[1])).toEqual({ error: computerUnavailableError });
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(computerFake.callsOf("run")).toEqual([]);
  });

  it("returns the couldn't-start note from the file tools too", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(toolCall({ name: "read", input: { path: "notes.md" } })),
      round(),
    ]);
    computerFake.failing.add("create");

    const events = await send(client, botId, "read my notes");

    expect(toolResultOf(fake.calls[1])).toEqual({ error: computerUnavailableError });
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
  });

  it("returns the couldn't-start note when an asleep Computer fails to resume", async () => {
    const { client, botId, fake, computerFake, user } = await botWith([
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
    computerFake.failing.add("resume");

    const events = await send(client, botId, "second");

    expect(toolResultOf(fake.calls[3])).toEqual({ error: computerUnavailableError });
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(computerFake.callsOf("run")).toHaveLength(1);
  });
});

describe("an operation the Computer fails", () => {
  it("is shell's result, an error the Model can act on, and the command never runs again", async () => {
    const { client, botId, fake, computerFake } = await botWith(
      [round(shell({ command: "echo hi", cwd: "/root/locked" })), round()],
      {
        onCommand: () => {
          throw new Error("mkdir /root/locked: permission denied");
        },
      },
    );

    const events = await send(client, botId, "run it");

    expect(toolResultOf(fake.calls[1]).error).toContain("permission denied");
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(computerFake.callsOf("run")).toHaveLength(1);
  });

  it("is a file tool's result: a read of a directory, a list of a file", async () => {
    const { client, botId, fake } = await botWith([
      round(
        file("write", { path: "notes/a.txt", content: "one" }),
        file("read", { path: "notes" }),
        file("list", { path: "notes/a.txt" }),
      ),
      round(),
    ]);

    const events = await send(client, botId, "go");

    const [, read, listed] = toolResultsOf(fake.calls[1]);
    expect(read.error).toContain("is a directory");
    expect(listed.error).toContain("is not a directory");
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
  });
});

describe("a user's Computer", () => {
  it("is created on its first operation, not before", async () => {
    const { client, botId, user } = await botWith([round()], { withMemory: false });

    await send(client, botId, "hi");

    // Without Memory, which reads the Computer at Turn start, a Turn that used no Computer tool
    // leaves the Computer alone.
    expect(await computerRow(user.id)).toBeUndefined();
  });
});

describe("a shell call whose attempt is cut off", () => {
  // Each test claims its Turn's job by hand: no job another test left behind may be claimed first.
  beforeEach(async () => {
    await getTestDb()
      .update(job)
      .set({ status: "cancelled" })
      .where(inArray(job.status, ["queued", "running"]));
  });

  /**
   * A Bot with `computer` on, whose Turn's job the test runs by hand, one attempt at a time, on
   * the fake job clock. Its one command runs until it is killed. Each attempt may run on its own
   * SDK instance, as on another process.
   */
  async function botOnHandRunJobs(rounds: Round[]) {
    const command = runsUntilKilled();
    const fake = createFakeAdapter({ rounds });
    const computerFake = fakeComputerProvider({ onCommand: command.onCommand });
    const timer = fakeJobClock(new Date());
    // Each instance's runner, which runs its attempts.
    const runners = new Map<TestDeps, InProcessRunner>();
    const instance = () => {
      let deps: TestDeps | undefined;
      // Never started: the test claims and runs each attempt. Stopped after the test, which
      // waits for its attempts' handlers, lost ones included.
      const jobs = inProcessRunner({
        db: getTestDb(),
        logger: silent,
        clock: timer.clock,
        drainMs: 1_000,
        deps: () => deps!,
      });
      started.push(jobs);
      deps = createTestSdk({
        plugins: [bot(), computer({ provider: computerFake.provider })],
        jobs,
        adapterFor: () => fake.adapter,
        memory: false,
      });
      runners.set(deps, jobs);
      return deps;
    };
    const deps = instance();
    const user = await insertUser();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const client = chatRpc({ user, deps });
    const { id: botId } = await client.bot.create({ name: "Ada", model });
    return {
      fake,
      computerFake,
      deps,
      client,
      user,
      botId,
      timer,
      instance,
      /** Resolves once the command runs. */
      commandStarted: command.started,
      /** Claims the Turn's job and runs one attempt of it on `on`, without waiting for it to end. */
      attempt: async (on: TestDeps = deps) => {
        const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: false });
        if (!claimed) throw new Error("Nothing to claim");
        return runners.get(on)!.runClaimed(claimed);
      },
    };
  }

  it("is killed when the Turn is stopped, and stays unanswered", async () => {
    const { client, botId, computerFake, attempt, timer, commandStarted } = await botOnHandRunJobs([
      round(shell({ command: "sleep 600", timeoutSeconds: 120 })),
    ]);
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "wait" });
    const running = attempt();
    await commandStarted;

    await client.bot.stop({ botId });
    // The running attempt sees the cancel at its next heartbeat.
    timer.tick();
    await running;

    expect(computerFake.callsOf("kill")).toEqual([
      {
        type: "kill",
        sandboxId: computerFake.callsOf("create")[0]?.sandboxId,
        command: "sleep 600",
      },
    ]);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "stopped" });
    const turn = await turnOf(botId);
    expect(turn).toMatchObject({ status: "stopped" });
    // The call never got a result, so the transcript leaves it out.
    expect(JSON.stringify(turn?.transcript)).not.toContain("sleep 600");
  });

  it("never runs again after a crash, and the resumed Turn returns the interrupted note", async () => {
    const { fake, computerFake, deps, botId, attempt, timer, instance, client, commandStarted } =
      await botOnHandRunJobs([round(shell({ command: "rm -rf build" })), round()]);
    await client.bot.send({ botId, id: uuidv7(), text: "clean up" });

    const lost = attempt();
    await commandStarted;
    // The process dies mid-command: its lease expires and the reaper re-queues the Turn's job.
    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
    timer.tick();
    await lost;
    // Another process resumes the Turn.
    await attempt(instance());

    expect(computerFake.callsOf("run").map((call) => call.command)).toEqual(["rm -rf build"]);
    expect(fake.calls).toHaveLength(2);
    expect(toolResultOf(fake.calls[1])).toEqual({ error: interruptedShellError });
    expect(await turnOf(botId)).toMatchObject({ status: "complete" });
  });

  it("still tells the rebuild in a retried attempt, after the rebuilding one died", async () => {
    const setup = await botOnHandRunJobs([
      round(shell({ command: "make all" })),
      round(file("list", {})),
      round(),
    ]);
    const { fake, computerFake, deps, user, attempt, timer, instance, client, botId } = setup;
    // The user's Computer is asleep, and its sandbox is lost: the Turn's first call rebuilds it.
    await deps.plugin("computer").forUser(user.id).list("/home/user");
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);
    await client.bot.send({ botId, id: uuidv7(), text: "build it" });

    const lost = attempt();
    await setup.commandStarted;
    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
    timer.tick();
    await lost;
    await attempt(instance());

    const rebuilt = await computerRow(user.id);
    expect(computerFake.callsOf("create")).toHaveLength(2);
    expect(toolResultsOf(fake.calls[2]).at(-1)).toMatchObject({
      note: rebuiltNote({ rebuiltAt: rebuilt!.rebuiltAt!, restoredAsOf: null }),
    });
  });
});

const file = (name: string, input: object) => toolCall({ name, input });

/** The results the Model got for its tool calls in model call `call`, parsed, in order. */
const toolResultsOf = (call: TextOptions | undefined) =>
  inputOf(call)
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(String(entry.content)));

describe("the file tools", () => {
  it("writes a file, reads it back with numbers, an offset and a limit, edits it and lists its directory", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(
        file("write", { path: "notes/a.txt", content: "one\ntwo\nthree\nfour\n" }),
        file("read", { path: "notes/a.txt" }),
        file("read", { path: "notes/a.txt", offset: 2, limit: 2 }),
        file("edit", { path: "notes/a.txt", oldText: "three", newText: "3" }),
        file("read", { path: "notes/a.txt", offset: 3, limit: 1 }),
        file("list", { path: "notes" }),
      ),
      round(),
    ]);

    await send(client, botId, "take notes");

    const directory = `/home/user/bots/${botId}`;
    const [written, whole, partial, edited, reread, listed] = toolResultsOf(fake.calls[1]);
    expect(written).toEqual({ path: `${directory}/notes/a.txt`, bytes: 19 });
    expect(whole).toEqual({ content: "1\tone\n2\ttwo\n3\tthree\n4\tfour", totalLines: 4 });
    expect(partial).toEqual({ content: "2\ttwo\n3\tthree", totalLines: 4, nextOffset: 4 });
    expect(edited).toEqual({ path: `${directory}/notes/a.txt`, replaced: 1 });
    expect(reread.content).toBe("3\t3");
    expect(listed).toEqual({
      path: `${directory}/notes`,
      entries: [{ name: "a.txt", kind: "file", size: 15 }],
    });
    expect(computerFake.callsOf("create")).toHaveLength(1);
  });

  it("reads a range without loading the file, and shows the rest by nextOffset", async () => {
    const { client, botId, fake, computerFake } = await botWith(
      [
        round(
          file("read", { path: "/tmp/big.log", offset: 3, limit: 2 }),
          file("read", { path: "/tmp/big.log", offset: 5, limit: 2 }),
          file("read", { path: "/tmp/big.log", offset: 9 }),
        ),
        round(),
      ],
      { withMemory: false },
    );
    computerFake.files.set("/tmp/big.log", new TextEncoder().encode("a\nb\nc\nd\ne\nlast"));
    const load = vi.spyOn(computerFake.provider, "readFile");

    await send(client, botId, "go");

    const [middle, tail, beyond] = toolResultsOf(fake.calls[1]);
    expect(middle).toEqual({ content: "3\tc\n4\td", totalLines: 6, nextOffset: 5 });
    expect(tail).toEqual({ content: "5\te\n6\tlast", totalLines: 6 });
    expect(beyond).toEqual({ content: "", totalLines: 6 });
    expect(load).not.toHaveBeenCalled();
  });

  it("returns an error that suggests shell when edit's file is over the size limit", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("edit", { path: "/tmp/huge.txt", oldText: "a", newText: "b" })),
      round(),
    ]);
    computerFake.files.set("/tmp/huge.txt", new Uint8Array(maxTextBytes + 1).fill(97));

    await send(client, botId, "go");

    const [edit] = toolResultsOf(fake.calls[1]);
    expect(edit.error).toContain("shell");
    expect(computerFake.files.get("/tmp/huge.txt")?.[0]).toBe(97);
  });

  it("cuts long lines when reading", async () => {
    const { client, botId, fake } = await botWith([
      round(
        file("write", { path: "long.txt", content: "x".repeat(2500) }),
        file("read", { path: "long.txt" }),
      ),
      round(),
    ]);

    await send(client, botId, "go");

    const [, read] = toolResultsOf(fake.calls[1]);
    expect(read.content).toBe(`1\t${"x".repeat(2000)}…`);
  });

  it("errors clearly when the text to edit is missing or ambiguous, and replaceAll replaces every one", async () => {
    const { client, botId, fake } = await botWith([
      round(
        file("write", { path: "a.txt", content: "cat cat dog" }),
        file("edit", { path: "a.txt", oldText: "bird", newText: "x" }),
        file("edit", { path: "a.txt", oldText: "cat", newText: "x" }),
        file("edit", { path: "a.txt", oldText: "cat", newText: "fox", replaceAll: true }),
        file("read", { path: "a.txt" }),
      ),
      round(),
    ]);

    await send(client, botId, "go");

    const [, missing, ambiguous, all, read] = toolResultsOf(fake.calls[1]);
    expect(missing.error).toContain("was not found");
    expect(ambiguous.error).toContain("appears 2 times");
    expect(ambiguous.error).toContain("replaceAll");
    expect(all.replaced).toBe(2);
    expect(read.content).toBe("1\tfox fox dog");
  });

  it("puts relative paths in the Bot's directory, and shares /home/user/shared between Bots", async () => {
    const { client, botId, computerFake, fake } = await botWith([
      round(
        file("write", { path: "mine.txt", content: "m" }),
        file("write", { path: "/home/user/shared/hand.txt", content: "h" }),
      ),
      round(),
    ]);
    const other = await client.bot.create({ name: "Bo", model });

    await send(client, botId, "go");

    expect([...computerFake.files.keys()].toSorted()).toEqual([
      `/home/user/bots/${botId}/mine.txt`,
      "/home/user/shared/hand.txt",
    ]);
    // Another Bot of the user sees the shared file, and not the first Bot's own.
    expect(fake.calls).toHaveLength(2);
    const sandboxId = computerFake.callsOf("create")[0]!.sandboxId;
    expect(await computerFake.provider.list(sandboxId, `/home/user/bots/${other.id}`)).toBeNull();
    expect(await computerFake.provider.list(sandboxId, "/home/user/shared")).toEqual([
      { name: "hand.txt", kind: "file", size: 1 },
    ]);
  });

  it("returns an error that suggests shell for a binary file", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("read", { path: "/tmp/a.bin" })),
      round(),
    ]);
    computerFake.files.set("/tmp/a.bin", new Uint8Array([1, 0, 2]));

    await send(client, botId, "go");

    const [result] = toolResultsOf(fake.calls[1]);
    expect(result.error).toContain("binary");
    expect(result.error).toContain("shell");
  });

  it("refuses to read or edit a file that isn't UTF-8, suggesting shell, and leaves it as it was", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(
        file("read", { path: "/tmp/latin1.txt" }),
        file("edit", { path: "/tmp/latin1.txt", oldText: "old", newText: "new" }),
      ),
      round(),
    ]);
    // "café old" in Latin-1: é is the lone byte 0xe9.
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6c, 0x64]);
    computerFake.files.set("/tmp/latin1.txt", latin1);

    await send(client, botId, "go");

    const [read, edited] = toolResultsOf(fake.calls[1]);
    expect(read.error).toContain("UTF-8");
    expect(read.error).toContain("shell");
    expect(edited.error).toContain("UTF-8");
    expect(edited.error).toContain("shell");
    expect(computerFake.files.get("/tmp/latin1.txt")).toEqual(latin1);
  });

  it("keeps a byte order mark through an edit", async () => {
    const { client, botId, computerFake } = await botWith([
      round(file("edit", { path: "/tmp/bom.txt", oldText: "old", newText: "new" })),
      round(),
    ]);
    const bom = [0xef, 0xbb, 0xbf];
    computerFake.files.set(
      "/tmp/bom.txt",
      new Uint8Array([...bom, ...new TextEncoder().encode("old")]),
    );

    await send(client, botId, "go");

    expect(computerFake.files.get("/tmp/bom.txt")).toEqual(
      new Uint8Array([...bom, ...new TextEncoder().encode("new")]),
    );
  });

  it("reads a page too big for one fetch in parts, and says where to read on", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("read", { path: "/tmp/wide.log" })),
      round(),
      round(file("read", { path: "/tmp/wide.log", offset: 2495 })),
      round(),
    ]);
    // 2,500 lines of 1,500 characters: a default page would be 3 MB, but a read returns at most 10,000 characters.
    const line = (n: number) => `${String(n).padStart(4, "0")}${"x".repeat(1496)}`;
    const lines = Array.from({ length: 2500 }, (_, index) => line(index + 1));
    computerFake.files.set("/tmp/wide.log", new TextEncoder().encode(`${lines.join("\n")}\n`));

    await send(client, botId, "read it");

    const [first] = toolResultsOf(fake.calls[1]);
    const rows: string[] = first.content.split("\n");
    expect(first.totalLines).toBe(2500);
    expect(first.nextOffset).toBeLessThan(2001);
    expect(rows).toHaveLength(first.nextOffset - 1);
    expect(rows).toEqual(rows.map((_, index) => `${index + 1}\t${line(index + 1)}`));
    expect(first.hint).toContain(String(first.nextOffset));

    await send(client, botId, "read the end");
    const last = toolResultsOf(fake.calls[3]).at(-1);
    expect(last.content.split("\n").at(-1)).toBe(`2500\t${line(2500)}`);
    expect(last).not.toHaveProperty("nextOffset");
    expect(last).not.toHaveProperty("hint");
  });

  it("pages at 10,000 characters, with a nextOffset that continues exactly where the page stopped", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("read", { path: "/tmp/pages.log" })),
      round(file("read", { path: "/tmp/pages.log", offset: 10 })),
      round(),
    ]);
    // 40 lines of 1,000 characters: nine numbered lines fit in a page, ten do not.
    const line = (n: number) => `${String(n).padStart(4, "0")}${"y".repeat(996)}`;
    const lines = Array.from({ length: 40 }, (_, index) => line(index + 1));
    computerFake.files.set("/tmp/pages.log", new TextEncoder().encode(`${lines.join("\n")}\n`));

    await send(client, botId, "read it");

    const [first, second] = toolResultsOf(fake.calls[2]);
    expect(first.content.length).toBeLessThanOrEqual(10_000);
    expect(first.nextOffset).toBe(first.content.split("\n").length + 1);
    expect(first.nextOffset).toBe(10);
    expect(first.hint).toContain("Read on with offset 10");
    expect(second.content.split("\n")[0]).toBe(`10\t${line(10)}`);
  });

  it("reads a file with a huge line, cut, without fetching the whole line", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("read", { path: "/tmp/one.json" })),
      round(),
    ]);
    computerFake.files.set(
      "/tmp/one.json",
      new TextEncoder().encode(`${"x".repeat(3_000_000)}\na${"€".repeat(3000)}\nend`),
    );

    await send(client, botId, "go");

    const [read] = toolResultsOf(fake.calls[1]);
    expect(read).toEqual({
      content: `1\t${"x".repeat(2000)}…\n2\ta${"€".repeat(1999)}…\n3\tend`,
      totalLines: 3,
    });
  });

  it("finds a binary or non-UTF-8 file by its whole content, not only the lines read", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(
        file("read", { path: "/tmp/late.bin", limit: 1 }),
        file("read", { path: "/tmp/late.txt", limit: 1 }),
      ),
      round(),
    ]);
    computerFake.files.set("/tmp/late.bin", new Uint8Array([0x61, 0x0a, 0x62, 0x00, 0x0a]));
    computerFake.files.set("/tmp/late.txt", new Uint8Array([0x61, 0x0a, 0x62, 0xe9, 0x0a]));

    await send(client, botId, "go");

    const [binary, latin1] = toolResultsOf(fake.calls[1]);
    expect(binary.error).toContain("binary");
    expect(latin1.error).toContain("not UTF-8");
  });

  it("reports what the Computer said when a file can't be read, not that it is missing", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(
        file("read", { path: "/etc/shadow" }),
        file("edit", { path: "/etc/shadow", oldText: "a", newText: "b" }),
      ),
      round(),
    ]);
    computerFake.files.set("/etc/shadow", new TextEncoder().encode("secret"));
    computerFake.unreadable.add("/etc/shadow");

    await send(client, botId, "go");

    const [read, edit] = toolResultsOf(fake.calls[1]);
    expect(read.error).toMatch(/^Your computer reported an error: .*Permission denied/);
    expect(edit.error).toMatch(/^Your computer reported an error: .*Permission denied/);
  });

  it("lists the Bot's own directory as empty on a fresh Computer", async () => {
    const { client, botId, fake } = await botWith([round(file("list", {})), round()]);

    await send(client, botId, "go");

    expect(toolResultsOf(fake.calls[1])[0]).toEqual({
      path: `/home/user/bots/${botId}`,
      entries: [],
    });
  });

  it("gives the file tools' commands the Turn's time left", async () => {
    let skewMs = 0;
    const { client, botId, computerFake } = await botWith(
      [round(shell({ command: "wait" })), round(file("read", { path: "a.txt" })), round()],
      {
        clock: () => new Date(Date.now() + skewMs),
        onCommand: () => {
          // The command took most of the Turn's time.
          skewMs = turnTimeLimitMs - 10_000;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await send(client, botId, "go");

    const [, read] = computerFake.callsOf("run");
    expect(read?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("errors for a missing file", async () => {
    const { client, botId, fake } = await botWith([
      round(file("read", { path: "nope.txt" })),
      round(),
    ]);

    await send(client, botId, "go");

    expect(toolResultsOf(fake.calls[1])[0].error).toContain("does not exist");
  });

  it("offers all five tools, and wakes the Computer on a file operation", async () => {
    const { client, botId, fake, user } = await botWith([round(file("list", {})), round()], {
      withMemory: true,
    });

    await send(client, botId, "go");

    expect(toolNamesOf(fake.calls[0])).toEqual(
      [
        ...botTools,
        "search_memory",
        "shell",
        "read",
        "write",
        "edit",
        "list",
        "start_helper",
        "check_helper",
        "message_helper",
        "stop_helpers",
      ].sort(),
    );
    expect(await computerRow(user.id)).toMatchObject({ state: "awake" });
  });
});

describe("a long shell output", () => {
  it("is cut in the result and saved in full under .outputs/, and the Checkpoint holds only the cut form", async () => {
    const big = `${"a".repeat(6000)}${"b".repeat(6000)}`;
    const { client, botId, fake, computerFake } = await botWith(
      [round(shell({ command: "cat big" })), round()],
      { onCommand: () => ({ exitCode: 0, stdout: big, stderr: "" }) },
    );

    await send(client, botId, "go");

    const result = toolResultOf(fake.calls[1]);
    const [path] = [...computerFake.files.keys()];
    expect(path?.startsWith(`/home/user/bots/${botId}/.outputs/`)).toBe(true);
    expect(path?.endsWith(".txt")).toBe(true);
    expect(new TextDecoder().decode(computerFake.files.get(path!))).toBe(big);
    expect(result.outputPath).toBe(path);
    expect(result.stdout.startsWith("a".repeat(2000))).toBe(true);
    expect(result.stdout.endsWith("b".repeat(2000))).toBe(true);
    expect(result.stdout.length).toBeLessThan(4200);
    // The Model's next input, built from the Checkpoint, never held the full output.
    expect(JSON.stringify(fake.calls[1]?.messages)).not.toContain("a".repeat(2001));
  });

  it("leaves an output at the threshold whole", async () => {
    const { client, botId, fake, computerFake } = await botWith(
      [round(shell({ command: "cat ok" })), round()],
      { onCommand: () => ({ exitCode: 0, stdout: "a".repeat(10_000), stderr: "" }) },
    );

    await send(client, botId, "go");

    expect(toolResultOf(fake.calls[1]).stdout).toHaveLength(10_000);
    expect(computerFake.files.size).toBe(0);
  });
});

describe("a long list result", () => {
  it("is cut to its ends, and the full listing is saved under .outputs/", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("list", { path: "/tmp/many" })),
      round(),
    ]);
    for (let n = 0; n < 400; n++) {
      computerFake.files.set(
        `/tmp/many/file-${String(n).padStart(4, "0")}-notes.txt`,
        new Uint8Array(3),
      );
    }

    await send(client, botId, "list it");

    const text = String(inputOf(fake.calls[1]).findLast((entry) => entry.role === "tool")?.content);
    const path = [...computerFake.files.keys()].find((name) => name.includes("/.outputs/"));
    expect(path?.startsWith(`/home/user/bots/${botId}/.outputs/`)).toBe(true);
    const saved = JSON.parse(new TextDecoder().decode(computerFake.files.get(path!)));
    expect(saved.entries).toHaveLength(400);
    expect(text).toContain(`The full text is saved at ${path}.`);
    expect(text).toMatch(/[... d+ characters left out ...]/);
    expect(text.length).toBeLessThan(4300);
    expect(text).toContain("file-0000-notes.txt");
    expect(text).not.toContain("file-0200-notes.txt");
  });

  it("leaves a result at the limit whole", async () => {
    const { client, botId, fake, computerFake } = await botWith([
      round(file("list", { path: "/tmp/few" })),
      round(),
    ]);
    computerFake.files.set("/tmp/few/a.txt", new Uint8Array(3));

    await send(client, botId, "list it");

    expect(toolResultOf(fake.calls[1]).entries).toHaveLength(1);
    expect([...computerFake.files.keys()].some((name) => name.includes(".outputs"))).toBe(false);
  });
});

describe("a rebuilt Computer", () => {
  it("says so once, in the first tool result after the rebuild, with the files restored", async () => {
    const { client, botId, fake, computerFake, deps, user } = await botWith([
      round(file("write", { path: "note.txt", content: "kept" })),
      round(),
      round(file("read", { path: "note.txt" }), file("list", {})),
      round(),
    ]);
    await send(client, botId, "take a note");
    // The Computer goes idle and sleeps, syncing its files, and then its snapshot is lost.
    await getTestDb()
      .update(computerTable)
      .set({ lastActiveAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(computerTable.userId, user.id));
    await drainJobs({ deps });
    const synced = await computerRow(user.id);
    expect(synced).toMatchObject({ state: "asleep", syncedAt: expect.any(Date) });
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);

    await send(client, botId, "read it back");

    const [read, listed] = toolResultsOf(fake.calls[3]).slice(-2);
    const { rebuiltAt } = (await computerRow(user.id))!;
    expect(read).toEqual({
      content: "1\tkept",
      totalLines: 1,
      note: rebuiltNote({ rebuiltAt: rebuiltAt!, restoredAsOf: synced!.syncedAt }),
    });
    expect(read.note).toBe(
      `Your computer was rebuilt: files were restored as of ${synced!.syncedAt!.toISOString()}, but installed programs may be missing.`,
    );
    expect(listed).not.toHaveProperty("note");
    expect(computerFake.callsOf("create")).toHaveLength(2);
  });

  it("never says files were restored by a rebuild that started empty, after a later sync", async () => {
    const { client, botId, fake, computerFake, deps, user } = await botWith([
      round(file("list", {})),
      round(),
    ]);
    // The Computer was never synced, so its rebuild starts empty; then a sync stores new files.
    const handle = deps.plugin("computer").forUser(user.id);
    await handle.list("/home/user");
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);
    await handle.writeFile("/home/user/shared/later.txt", "new");
    await getTestDb()
      .update(computerTable)
      .set({ lastActiveAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(computerTable.userId, user.id));
    await drainJobs({ deps });
    expect(await computerRow(user.id)).toMatchObject({ syncedAt: expect.any(Date) });

    await send(client, botId, "look");

    const { rebuiltAt } = (await computerRow(user.id))!;
    const { note } = toolResultsOf(fake.calls[1]).at(-1);
    expect(note).toContain(rebuiltAt!.toISOString());
    expect(note).not.toMatch(/were restored/);
  });

  it("tells each of the user's Bots once, and not a Bot created after it", async () => {
    const { client, botId, fake, computerFake, deps, user } = await botWith([
      round(file("write", { path: "note.txt", content: "kept" })),
      round(),
      round(file("list", {})),
      round(),
      round(file("list", {}), file("list", {})),
      round(),
      round(file("list", {})),
      round(),
      round(file("list", {})),
      round(),
    ]);
    const { id: otherId } = await client.bot.create({ name: "Bo", model });
    await send(client, botId, "take a note");
    await getTestDb()
      .update(computerTable)
      .set({ lastActiveAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(computerTable.userId, user.id));
    await drainJobs({ deps });
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);

    // The first Bot's Turn rebuilds the Computer and is told.
    await send(client, botId, "look");
    expect(toolResultsOf(fake.calls[3]).at(-1)).toHaveProperty("note");
    // The other Bot is told on its first Computer result, once.
    await send(client, otherId, "look");
    const [first, second] = toolResultsOf(fake.calls[5]).slice(-2);
    expect(first).toHaveProperty("note");
    expect(second).not.toHaveProperty("note");
    // The first Bot isn't told again.
    await send(client, botId, "look again");
    expect(toolResultsOf(fake.calls[7]).at(-1)).not.toHaveProperty("note");
    // A Bot created after the rebuild had nothing on the Computer to lose.
    const { id: laterId } = await client.bot.create({ name: "Cy", model });
    await send(client, laterId, "look");
    expect(toolResultsOf(fake.calls[9]).at(-1)).not.toHaveProperty("note");
    expect(computerFake.callsOf("create")).toHaveLength(2);
    const seen = await getTestDb().select().from(botTable).where(eq(botTable.userId, user.id));
    expect(seen.find((row) => row.id === otherId)?.computerRebuildSeenAt).toEqual(
      (await computerRow(user.id))?.rebuiltAt,
    );
  });
});

describe("a user delete during a Turn", () => {
  it("leaves no Computer behind: the Turn's next tool call creates no row, sandbox or blob", async () => {
    let deleteUser = async () => {};
    const { client, botId, fake, computerFake, deps, user } = await botWith(
      [round(shell({ command: "first" })), round(shell({ command: "second" })), round()],
      {
        onCommand: async ({ command }) => {
          // The user's delete commits while their Turn is mid-step.
          if (command === "first") await deleteUser();
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    deleteUser = () => deleteUserData(deps, user.id);

    const stream = await client.bot.send({ botId, id: uuidv7(), text: "go" });
    await expect
      .poll(async () => {
        const [turnJob] = await getTestDb()
          .select({ status: job.status })
          .from(job)
          .where(eq(job.name, "bot.turn"));
        return turnJob?.status;
      })
      .toMatch(/succeeded|failed/);
    await stream.return?.(undefined);

    expect(computerFake.callsOf("run").map((call) => call.command)).toEqual(["first"]);
    expect(computerFake.callsOf("create")).toHaveLength(1);
    expect(computerFake.callsOf("kill-sandbox")).toHaveLength(1);
    expect(await computerRow(user.id)).toBeUndefined();
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(toolResultOf(fake.calls[2])).toEqual({ error: computerUnavailableError });
    await drainJobs({ deps });
    expect(await deps.blobStore.get(`computer/${user.id}`)).toBeNull();
  });
});
