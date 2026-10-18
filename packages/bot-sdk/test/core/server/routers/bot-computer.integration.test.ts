import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { botTurn, computer as computerTable, job } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
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
import {
  claimJob,
  reapStaleJobs,
  runClaimedJob,
} from "../../../../plugins/runner/server/jobs/store";
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
 * `onCommand` answers.
 */
async function botWith(
  rounds: Round[],
  {
    withComputer = true,
    onCommand,
  }: {
    withComputer?: boolean;
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

    expect(toolNamesOf(fake.calls[0])).toEqual([
      "send_to_user",
      "shell",
      "read",
      "write",
      "edit",
      "list",
    ]);
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
      { type: "kill", sandboxId: "fake-sandbox-1", command: "make all" },
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
    const { client, botId, user } = await botWith([round()]);

    await send(client, botId, "hi");

    // A Turn that used no Computer tool leaves the Computer alone.
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
    const instance = () => {
      let deps: TestDeps | undefined;
      // Never started: the test claims and runs each attempt.
      const jobs = inProcessRunner({
        db: getTestDb(),
        logger: silent,
        clock: timer.clock,
        deps: () => deps!,
      });
      deps = createTestSdk({
        plugins: [bot(), computer({ provider: computerFake.provider })],
        jobs,
        adapterFor: () => fake.adapter,
      });
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
      botId,
      timer,
      instance,
      /** Resolves once the command runs. */
      commandStarted: command.started,
      /** Claims the Turn's job and runs one attempt of it on `on`, without waiting for it to end. */
      attempt: async (on: TestDeps = deps) => {
        const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: false });
        if (!claimed) throw new Error("Nothing to claim");
        return runClaimedJob(getTestDb(), claimed, {
          clock: timer.clock,
          logger: silent,
          deps: () => on,
        });
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
      { type: "kill", sandboxId: "fake-sandbox-1", command: "sleep 600" },
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

  it("errors for a missing file", async () => {
    const { client, botId, fake } = await botWith([
      round(file("read", { path: "nope.txt" })),
      round(),
    ]);

    await send(client, botId, "go");

    expect(toolResultsOf(fake.calls[1])[0].error).toContain("does not exist");
  });

  it("offers all five tools, and wakes the Computer on a file operation", async () => {
    const { client, botId, fake, user } = await botWith([round(file("list", {})), round()]);

    await send(client, botId, "go");

    expect(toolNamesOf(fake.calls[0])).toEqual([
      "send_to_user",
      "shell",
      "read",
      "write",
      "edit",
      "list",
    ]);
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
    expect(read).toEqual({
      content: "1\tkept",
      totalLines: 1,
      note: rebuiltNote({ restoredAsOf: synced!.syncedAt }),
    });
    expect(read.note).toBe(
      `Your computer was rebuilt: files were restored as of ${synced!.syncedAt!.toISOString()}, but installed programs may be missing.`,
    );
    expect(listed).not.toHaveProperty("note");
    expect(computerFake.callsOf("create")).toHaveLength(2);
  });
});
