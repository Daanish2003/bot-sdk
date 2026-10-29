import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botCheckIn, botPromptStart, botRoutine, botTurn } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = ReturnType<typeof round>;

const now = new Date("2030-03-15T12:00:00Z");

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/**
 * A user with an OpenAI key and a Bot "Ada", with `computer` and `memory` on. The Model plays
 * `turnRounds` in the Bot's Turn calls, in order, and answers the memory pass with nothing.
 */
async function botWith(turnRounds: Round[]) {
  const queue = [...turnRounds];
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 60 },
      () => (options: TextOptions) => (isTurnCall(options) ? (queue.shift() ?? round()) : round()),
    ),
  });
  const computerFake = fakeComputerProvider();
  const offset = now.getTime() - Date.now();
  const clock = () => new Date(Date.now() + offset);
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now: clock },
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    memory: true,
    jobs,
    adapterFor: () => fake.adapter,
    clock,
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
  return { fake, computerFake, client, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, {
    botId,
    id: uuidv7(),
    text,
    timeZone: "Europe/London",
  })) {
    // Read to the end of the Turn.
  }
}

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The Bot's Turn calls: the memory pass's own calls don't start with the environment. */
const turnCalls = (calls: TextOptions[]) => calls.filter(isTurnCall);

/** The newest message of the first call whose newest message holds `text`. */
function newestWith(calls: TextOptions[], text: string): string {
  for (const call of turnCalls(calls)) {
    const newest = String(messagesOf(call).at(-1)?.content);
    if (newest.includes(text)) return newest;
  }
  throw new Error(`No call's newest message holds "${text}"`);
}

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

const startOf = async (botId: string) =>
  (await getTestDb().select().from(botPromptStart).where(eq(botPromptStart.botId, botId)))[0]!;

const deferredNames = [
  "create_routine",
  "update_routine",
  "delete_routine",
  "set_check_in",
  "cancel_check_in",
  "list_check_ins",
  "check_helper",
  "message_helper",
  "stop_helpers",
];

const toolResults = (calls: TextOptions[]) =>
  messagesOf(turnCalls(calls).at(-1))
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(String(entry.content)) as Record<string, unknown>);

const runTool = (name: string, args: unknown) =>
  toolCall({ name: "run_tool", input: { name, args } });

describe("Names-first tools", () => {
  it("send a fixed list of tools, and list the deferred ones in the first message", async () => {
    const { fake, client, botId } = await botWith([round()]);
    await send(client, botId, "hello");

    const sent = turnCalls(fake.calls)[0]!;
    const names = (sent.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "describe_tool",
        "edit",
        "list",
        "read",
        "run_tool",
        "search_memory",
        "send_to_user",
        "shell",
        "start_helper",
        "web_search",
        "write",
      ].sort(),
    );
    const first = String(messagesOf(sent)[0]?.content);
    const deferred = first.slice(first.indexOf("[Deferred tools"));
    for (const name of deferredNames) expect(deferred).toContain(`${name}: `);
    expect(first.slice(0, first.indexOf("[Deferred tools"))).not.toContain("create_routine: ");
    expect(deferred).toContain("describe_tool");
  });

  it("run_tool creates a Routine that still waits for Approval, and sets a Check-in", async () => {
    const { fake, client, botId } = await botWith([
      round(
        toolCall({ name: "describe_tool", input: { name: "create_routine" } }),
        runTool("create_routine", {
          name: "morning-brief",
          prompt: "Summarize today.",
          schedule: { days: ["mon"], times: ["08:00"] },
        }),
        runTool("set_check_in", { at: "2030-03-16T09:00:00Z", note: "Look at the brief" }),
      ),
      round(),
    ]);
    await send(client, botId, "set things up");

    const [routine] = await getTestDb()
      .select()
      .from(botRoutine)
      .where(eq(botRoutine.botId, botId));
    expect(routine).toMatchObject({ name: "morning-brief", approvedAt: null });
    expect(routine!.state).not.toBe("active");
    const [checkIn] = await getTestDb()
      .select()
      .from(botCheckIn)
      .where(eq(botCheckIn.botId, botId));
    expect(checkIn).toMatchObject({ note: "Look at the brief", state: "pending" });
    const [described] = toolResults(fake.calls);
    expect(described).toMatchObject({ name: "create_routine" });
    expect(JSON.stringify(described)).toContain("schedule");
    // Every tool that was sent stays the same: no deferred tool appears in `tools`.
    for (const call of turnCalls(fake.calls)) {
      const names = (call.tools ?? []).map((tool) => tool.name);
      expect(names).toEqual(expect.not.arrayContaining(deferredNames));
    }
  });

  it("answers an unknown name, and bad args with the current schema", async () => {
    const { fake, client, botId } = await botWith([
      round(
        toolCall({ name: "describe_tool", input: { name: "nope" } }),
        runTool("nope", {}),
        runTool("set_check_in", { at: "not a date" }),
      ),
      round(),
    ]);
    await send(client, botId, "try");

    const [described, ran, bad] = toolResults(fake.calls);
    const unknown = "No tool named nope. The tools are listed in your first message.";
    expect(described).toEqual({ error: unknown });
    expect(ran).toEqual({ error: unknown });
    expect(String(bad?.error)).toMatch(/Invalid arguments for set_check_in .*note/);
    expect(await getTestDb().select().from(botCheckIn)).toHaveLength(0);
  });

  it("note a tool added after the Prompt start, once, and run it through run_tool", async () => {
    const { fake, client, botId } = await botWith([
      round(),
      round(runTool("list_check_ins", {})),
      round(),
      round(),
    ]);
    await send(client, botId, "turn one");
    // A deploy added list_check_ins: the Prompt start never listed it.
    const start = await startOf(botId);
    await getTestDb()
      .update(botPromptStart)
      .set({
        sections: start.sections.map((section) =>
          section.name === "first_message"
            ? { ...section, text: section.text.replace(/\nlist_check_ins: .*/, "") }
            : section,
        ),
      })
      .where(eq(botPromptStart.id, start.id));
    await send(client, botId, "turn two");
    await send(client, botId, "turn three");

    expect(newestWith(fake.calls, "turn one")).not.toContain("[Tool added");
    expect(newestWith(fake.calls, "turn two")).toMatch(
      /\[Tool added: list_check_ins\. .*run_tool\.\]/,
    );
    expect(newestWith(fake.calls, "turn three")).not.toContain("[Tool added");
    expect((await turnsOf(botId)).map((turn) => turn.status)).toEqual([
      "complete",
      "complete",
      "complete",
    ]);
  });

  it("keeps every tool's description and schema under 4,000 characters", async () => {
    const { fake, client, botId } = await botWith([
      round(...deferredNames.map((name) => toolCall({ name: "describe_tool", input: { name } }))),
      round(),
    ]);
    await send(client, botId, "describe them all");

    const sizes = [
      ...(await startOf(botId)).tools.map((tool) => JSON.stringify(tool).length),
      ...toolResults(fake.calls).map((result) => JSON.stringify(result).length),
    ];
    expect(sizes).toHaveLength(11 + deferredNames.length);
    for (const size of sizes) expect(size).toBeLessThan(4_000);
  });
});
