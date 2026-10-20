import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botPromptStart, botRoutine, botTurn } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = ReturnType<typeof round>;

const now = new Date("2030-03-15T12:00:00Z");

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const profilePath = (botId: string) => `/home/user/bots/${botId}/memory/profile.md`;
const encode = (text: string) => new TextEncoder().encode(text);

const isTurnCall = (options: TextOptions) =>
  String((options.messages as ModelMessage[] | undefined)?.[0]?.content).startsWith(
    "[Your environment]",
  );

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
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: computerFake.provider })],
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
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { fake, computerFake, client, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await client.bot.send({
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
const turnCalls = (calls: TextOptions[]) =>
  calls.filter((call) => String(messagesOf(call)[0]?.content).startsWith("[Your environment]"));

/** The newest message of the first call whose newest message holds `text`. */
function newestWith(calls: TextOptions[], text: string): string {
  for (const call of turnCalls(calls)) {
    const newest = String(messagesOf(call).at(-1)?.content);
    if (newest.includes(text)) return newest;
  }
  throw new Error(`No call's newest message holds "${text}"`);
}

/** How many times `text` appears in everything the last Turn call sent. */
const timesSent = (calls: TextOptions[], text: string) =>
  JSON.stringify(messagesOf(turnCalls(calls).at(-1))).split(text).length - 1;

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

describe("Change notes", () => {
  it("note a memory line added or removed since the Prompt start, with its text, once", async () => {
    const { fake, computerFake, client, botId } = await botWith([round(), round(), round()]);
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));

    await send(client, botId, "turn one");
    computerFake.files.set(profilePath(botId), encode("- Likes tea\n"));
    await send(client, botId, "turn two");
    await send(client, botId, "turn three");

    const first = newestWith(fake.calls, "turn one");
    expect(first).not.toContain("Memory added");
    const second = newestWith(fake.calls, "turn two");
    expect(second).toContain("Memory added (Profile): Likes tea");
    expect(second).toContain("Memory removed (Profile): Prefers short replies");
    // The notes come after the time and before what woke the Bot.
    expect(second.indexOf("Memory added")).toBeGreaterThan(second.indexOf("2030"));
    expect(second.indexOf("Memory added")).toBeLessThan(second.indexOf("turn two"));
    expect(newestWith(fake.calls, "turn three")).not.toContain("Memory");
    // Turn two's input stays in the history as it was, so the note is sent once.
    expect(timesSent(fake.calls, "Memory added (Profile): Likes tea")).toBe(1);
  });

  it("give no note for the Bot's own writes, but note a later edit by the user", async () => {
    const { fake, computerFake, client, botId } = await botWith([
      round(
        toolCall({
          name: "write",
          input: { path: "memory/profile.md", content: "- Prefers short replies\n- Likes tea\n" },
        }),
      ),
      round(),
      round(
        toolCall({
          name: "edit",
          input: { path: "memory/profile.md", oldText: "Likes tea", newText: "Likes coffee" },
        }),
      ),
      round(),
      round(),
    ]);
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));
    const fileText = () => new TextDecoder().decode(computerFake.files.get(profilePath(botId)));

    await send(client, botId, "turn one");
    expect(fileText()).toContain("tea");
    await send(client, botId, "turn two");
    expect(fileText()).toContain("coffee");
    computerFake.files.set(
      profilePath(botId),
      encode("- Prefers short replies\n- Likes coffee\n- Lives in Berlin\n"),
    );
    await send(client, botId, "turn three");

    expect(newestWith(fake.calls, "turn two")).not.toContain("Memory");
    const third = newestWith(fake.calls, "turn three");
    expect(third).toContain("Memory added (Profile): Lives in Berlin");
    expect(third).not.toContain("Likes");
  });

  it("note a Routine created, approved and deleted, once each", async () => {
    const { fake, client, botId } = await botWith([round(), round(), round(), round()]);

    await send(client, botId, "turn one");
    const [turn] = await turnsOf(botId);
    const routine = {
      id: uuidv7(),
      botId,
      name: "morning-brief",
      prompt: "Summarise the news.",
      schedule: { days: ["mon" as const], at: "08:00" },
      timeZone: "Europe/London",
      state: "pending" as const,
      createdByTurnId: turn!.id,
      createdAt: now,
      updatedAt: now,
    };
    await getTestDb().insert(botRoutine).values(routine);
    await send(client, botId, "turn two");
    await getTestDb()
      .update(botRoutine)
      .set({ state: "active", approvedAt: now })
      .where(eq(botRoutine.id, routine.id));
    await send(client, botId, "turn three");
    await getTestDb().delete(botRoutine).where(eq(botRoutine.id, routine.id));
    await send(client, botId, "turn four");

    expect(newestWith(fake.calls, "turn one")).not.toContain("Routine");
    const second = newestWith(fake.calls, "turn two");
    expect(second).toContain("Routine created: morning-brief");
    expect(second).toContain("(waiting for OK)");
    const third = newestWith(fake.calls, "turn three");
    expect(third).toContain("Routine approved: morning-brief");
    expect(third).not.toContain("Routine created");
    const fourth = newestWith(fake.calls, "turn four");
    expect(fourth).toContain("Routine deleted: morning-brief");
    expect(fourth).not.toContain("Routine approved");
    expect(timesSent(fake.calls, "Routine created: morning-brief")).toBe(1);
  });

  it("note a tool whose definition changed in a deploy, once, and run it against the current schema", async () => {
    const { fake, client, botId } = await botWith([
      round(),
      round(toolCall({ name: "send_to_user", input: { text: "hello" } })),
      round(),
      round(),
    ]);

    await send(client, botId, "turn one");
    // A deploy changed the tool: what the Prompt start stored is no longer the code's.
    const [start] = await getTestDb()
      .select()
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId));
    await getTestDb()
      .update(botPromptStart)
      .set({
        tools: start!.tools.map((tool) =>
          tool.name === "send_to_user" ? { ...tool, description: "The old description." } : tool,
        ),
      })
      .where(eq(botPromptStart.id, start!.id));
    await send(client, botId, "turn two");
    await send(client, botId, "turn three");

    expect(newestWith(fake.calls, "turn one")).not.toContain("[Tool changed");
    expect(newestWith(fake.calls, "turn two")).toMatch(/\[Tool changed: send_to_user\. /);
    expect(newestWith(fake.calls, "turn three")).not.toContain("[Tool changed");
    expect(timesSent(fake.calls, "[Tool changed: send_to_user")).toBe(1);
    // The call ran against the current schema: the missing endTurn is an error that says so.
    const results = turnCalls(fake.calls).flatMap((call) =>
      messagesOf(call).filter((entry) => entry.role === "tool"),
    );
    expect(JSON.stringify(results)).toMatch(/endTurn.*Call send_to_user again/);
  });

  it("keeps a tool removed by a deploy defined, and answers that it is no longer available", async () => {
    const { fake, client, botId } = await botWith([
      round(),
      round(toolCall({ name: "retired_tool", input: { anything: 1 } })),
      round(),
    ]);

    await send(client, botId, "turn one");
    const [start] = await getTestDb()
      .select()
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId));
    const retired = {
      name: "retired_tool",
      description: "Does an old thing.",
      inputSchema: { type: "object" as const },
    };
    await getTestDb()
      .update(botPromptStart)
      .set({ tools: [...start!.tools, retired].sort((a, b) => (a.name < b.name ? -1 : 1)) })
      .where(eq(botPromptStart.id, start!.id));
    await send(client, botId, "turn two");

    const sent = turnCalls(fake.calls).at(-1);
    expect((sent?.tools ?? []).map((tool) => tool.name)).toContain("retired_tool");
    const result = messagesOf(sent).find(
      (entry) => entry.role === "tool" && String(entry.content).includes("no longer available"),
    );
    expect(result).toBeDefined();
  });
});
