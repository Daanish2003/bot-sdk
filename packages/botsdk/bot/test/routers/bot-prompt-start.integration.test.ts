import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { botHelper, botPromptStart, botTurn, job, usage } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import {
  inProcessRunner,
  type JobRunner,
  systemClock,
  claimJob,
  reapStaleJobs,
} from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The fake clock's "now": every Turn starts a few milliseconds after it. */
const now = new Date("2030-03-15T12:00:00Z");

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const profilePath = (botId: string) => `/home/user/bots/${botId}/memory/profile.md`;
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * A user with an OpenAI key and a Bot "Ada", over an SDK whose Model plays `rounds`, on a clock
 * that reads `now`. With `withComputer` (the default), `computer` and `memory` are on.
 */
async function botWith(rounds: Round[], { withComputer = true, modelId = model } = {}) {
  const fake = createFakeAdapter({ rounds });
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
    ...(withComputer && { computer: computerFake.provider }),
    memory: withComputer,
    jobs,
    adapterFor: () => fake.adapter,
    clock,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: modelId.split(":")[0]!,
    fields: { apiKey: "test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model: modelId });
  return { fake, computerFake, client, botId };
}

async function send(
  client: ReturnType<typeof chatRpc>,
  botId: string,
  text: string,
  timeZone?: string,
) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text, timeZone })) {
    // Read to the end of the Turn.
  }
}

/** The first message a model call sent, which opens with the Bot's environment. */
const firstMessageOf = (call: TextOptions | undefined) =>
  String((call?.messages as ModelMessage[] | undefined)?.[0]?.content ?? "");

/** The model calls of the Bot's Turns, not of its memory pass. */
const turnCalls = (calls: TextOptions[]) => calls.filter(isTurnCall);

/** What a model call sent of the Prompt start: tools, system blocks and the first message. */
const promptStartSent = (call: TextOptions | undefined) =>
  JSON.stringify({
    tools: call?.tools,
    systemPrompts: call?.systemPrompts,
    first: firstMessageOf(call),
  });

const toolNamesOf = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

const promptStartsOf = (botId: string) =>
  getTestDb().select().from(botPromptStart).where(eq(botPromptStart.botId, botId));

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

/** The prompt hashes of the Bot's Turns' model calls, in call order. */
async function hashesOf(botId: string) {
  const turns = await turnsOf(botId);
  const rows = await getTestDb()
    .select({ promptHashes: usage.promptHashes })
    .from(usage)
    .where(
      and(
        eq(usage.kind, "turn"),
        inArray(
          usage.sourceId,
          turns.map((turn) => turn.id),
        ),
      ),
    )
    .orderBy(asc(usage.createdAt), asc(usage.id));
  return rows.map((row) => row.promptHashes ?? []);
}

/** The sections a call's hashes flag as changed. */
const flagged = (hashes: { name: string; changed?: string }[]) =>
  hashes.filter((entry) => entry.changed).map(({ name, changed }) => ({ name, changed }));

const createRoutine = toolCall({
  name: "create_routine",
  input: {
    name: "morning-brief",
    prompt: "Summarise the news.",
    schedule: { days: ["mon"], times: ["08:00"] },
  },
});

describe("a Bot's Prompt start", () => {
  it("is built by the first Turn, and later Turns send its bytes after memory files and Routines change", async () => {
    const { fake, computerFake, client, botId } = await botWith([
      round(createRoutine),
      round(),
      round(),
    ]);
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));

    await send(client, botId, "save a routine", "Europe/London");
    computerFake.files.set(profilePath(botId), encode("- Prefers long replies\n"));
    await send(client, botId, "hi", "Europe/London");

    const [start, ...more] = await promptStartsOf(botId);
    expect(more).toEqual([]);
    expect((await turnsOf(botId)).map((turn) => turn.promptStartId)).toEqual([
      start!.id,
      start!.id,
    ]);
    const calls = turnCalls(fake.calls);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(promptStartSent(call)).toBe(promptStartSent(calls[0]));
    // The snapshot and Routines as the first Turn found them, frozen until the next Summary.
    const prompts = JSON.stringify(calls[2]?.systemPrompts);
    expect(prompts).toContain("Prefers short replies");
    expect(prompts).not.toContain("Prefers long replies");
    expect(prompts).not.toContain("morning-brief");
    // The stored row holds exactly what was sent.
    expect(calls[2]?.systemPrompts).toEqual(
      start!.sections.filter((section) => section.name !== "first_message").map((s) => s.text),
    );
    expect(firstMessageOf(calls[2])).toBe(start!.sections.at(-1)?.text);
    expect(JSON.parse(JSON.stringify(calls[2]?.tools))).toEqual(start!.tools);
  });

  it("sends the tools sorted by name, the system blocks in order, and a first message with the environment and every tool", async () => {
    const { fake, computerFake, client, botId } = await botWith([round()]);
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));

    await send(client, botId, "hi", "Europe/London");

    const [call] = turnCalls(fake.calls);
    const names = toolNamesOf(call);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("start_helper");
    const prompts = (call?.systemPrompts ?? []).map(String);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toMatch(/^You are a Bot/);
    expect(prompts[1]).toMatch(/^You have a computer/);
    expect(prompts[2]).toMatch(/^Your memory/);
    const first = firstMessageOf(call);
    expect(first).toContain("Your name: Ada");
    expect(first).toContain("The user's time zone: Europe/London");
    expect(first).toMatch(/built: .*15 March 2030.*\(Europe\/London\)/);
    expect(first).toContain(`Computer: on. Your own directory is /home/user/bots/${botId}`);
    expect(first).toContain("/home/user/shared");
    expect(first).toContain(`Memory: on. Your memory files are in /home/user/bots/${botId}/memory`);
    expect(first).toContain("Helpers: on.");
    for (const tool of call?.tools ?? []) {
      expect(first).toContain(`\n${tool.name}: ${tool.description.split(/(?<=[.!?])\s/)[0]}`);
    }
  });

  it("says Computer and Helpers are off, and nothing of Memory, with no computer plugin", async () => {
    const { fake, client, botId } = await botWith([round()], { withComputer: false });

    await send(client, botId, "hi");

    const first = firstMessageOf(turnCalls(fake.calls)[0]);
    expect(first).toContain("The user's time zone: UTC");
    expect(first).toContain("Computer: off.");
    // Without the Memory feature the Prompt start says nothing about Memory.
    expect(first).not.toContain("Memory:");
    expect(first).toContain("Helpers: off.");
    expect(first).not.toContain("/home/user");
  });
});

describe("the prompt hashes of a model call", () => {
  it("hash each section and the history, and flag nothing while the Prompt start holds", async () => {
    const { client, botId } = await botWith([round(createRoutine), round(), round()], {
      withComputer: false,
    });

    await send(client, botId, "save a routine");
    await send(client, botId, "hi");

    const calls = await hashesOf(botId);
    expect(calls).toHaveLength(3);
    for (const hashes of calls) {
      expect(hashes.map((entry) => entry.name)).toEqual([
        "tools",
        "rules",
        "first_message",
        "history",
      ]);
      expect(flagged(hashes)).toEqual([]);
    }
    // Each section's hash is the same on every call; only the history grows.
    expect(calls[2]!.slice(0, 3)).toEqual(calls[0]!.slice(0, 3));
    expect(calls.map((hashes) => hashes.at(-1)?.messages)).toEqual([1, 3, 4]);
  });

  it("names a section that changed under the same Prompt start as a bug", async () => {
    const { client, botId } = await botWith([round(), round()], { withComputer: false });

    await send(client, botId, "hi");
    const [start] = await promptStartsOf(botId);
    await getTestDb()
      .update(botPromptStart)
      .set({
        sections: start!.sections.map((section) =>
          section.name === "rules" ? { ...section, text: `${section.text} ` } : section,
        ),
      })
      .where(eq(botPromptStart.id, start!.id));
    await send(client, botId, "again");

    const calls = await hashesOf(botId);
    expect(flagged(calls[1]!)).toEqual([{ name: "rules", changed: "bug" }]);
  });

  it("reads each Turn's Steps with their usage and the flagged section, by source_id", async () => {
    const { client, botId } = await botWith([round(), round()], { withComputer: false });

    await send(client, botId, "hi");
    const [start] = await promptStartsOf(botId);
    await getTestDb()
      .update(botPromptStart)
      .set({
        sections: start!.sections.map((section) =>
          section.name === "rules" ? { ...section, text: `${section.text} ` } : section,
        ),
      })
      .where(eq(botPromptStart.id, start!.id));
    await send(client, botId, "again");

    const { turns } = await client.bots.get({ botId });
    const [first, second] = turns.map((turn) => turn.steps);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first![0]!.changed).toBeNull();
    expect(first![0]!.sections.every((section) => section.tokens > 0)).toBe(true);
    const rules = (step: NonNullable<typeof first>[number]) =>
      step.sections.find((section) => section.name === "rules")!;
    expect(second![0]!.changed).toEqual({ section: "rules", kind: "bug" });
    expect(rules(second![0]!).was).toBe(rules(first![0]!).hash);
    expect(rules(second![0]!).hash).not.toBe(rules(first![0]!).hash);
  });

  it("names a change to the history the previous call sent as a bug", async () => {
    const { client, botId } = await botWith([round(), round()], { withComputer: false });

    await send(client, botId, "hi");
    const [turn] = await turnsOf(botId);
    await getTestDb()
      .update(botTurn)
      .set({ input: [{ role: "user", content: "hi, rewritten" }] })
      .where(eq(botTurn.id, turn!.id));
    await send(client, botId, "again");

    const calls = await hashesOf(botId);
    expect(flagged(calls[1]!)).toEqual([{ name: "history", changed: "bug" }]);
  });

  it("names the first section that differs after a new Prompt start as expected", async () => {
    const { client, botId } = await botWith([round(), round()], { withComputer: false });

    await send(client, botId, "hi");
    const [start] = await promptStartsOf(botId);
    // A newer Prompt start whose first message differs, as a Summary would build it.
    await getTestDb()
      .insert(botPromptStart)
      .values({
        ...start!,
        id: uuidv7(),
        builtAt: new Date(start!.builtAt.getTime() + 1_000),
        sections: start!.sections.map((section) =>
          section.name === "first_message"
            ? { ...section, text: `${section.text}\n\n[Summary]` }
            : section,
        ),
      });
    await send(client, botId, "again");

    const calls = await hashesOf(botId);
    expect(flagged(calls[1]!)).toEqual([{ name: "first_message", changed: "expected" }]);
  });
});

describe("a Turn that resumes after a crash", () => {
  beforeEach(async () => {
    await getTestDb()
      .update(job)
      .set({ status: "cancelled" })
      .where(inArray(job.status, ["queued", "running"]));
  });

  it("sends the Prompt start its first attempt chose, not a newer one", async () => {
    const fake = createFakeAdapter({ rounds: [round(), round()], manual: true });
    const timer = fakeJobClock(now);
    const runners = new Map<TestDeps, JobRunner>();
    const instance = () => {
      let deps: TestDeps | undefined;
      const jobs = inProcessRunner({
        db: getTestDb(),
        logger: silent,
        clock: timer.clock,
        drainMs: 1_000,
        jobs: () => deps!.parts.jobs,
      });
      started.push(jobs);
      deps = createTestSdk({
        memory: false,
        jobs,
        adapterFor: () => fake.adapter,
        clock: () => timer.clock.now(),
      });
      runners.set(deps, jobs);
      return deps;
    };
    const attempt = async (on: TestDeps) => {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: false });
      if (!claimed) throw new Error("Nothing to claim");
      return runners.get(on)!.runClaimed(claimed, {});
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
    const { id: botId } = await client.bots.create({ name: "Ada", model });
    await followSend(client, { botId, id: uuidv7(), text: "hi" });

    const lost = attempt(deps);
    // The attempt has chosen its Prompt start and waits in its model call.
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBe(1);
    const [start] = await promptStartsOf(botId);
    await getTestDb()
      .insert(botPromptStart)
      .values({
        ...start!,
        id: uuidv7(),
        builtAt: new Date(start!.builtAt.getTime() + 1_000),
        sections: start!.sections.map((section) => ({ ...section, text: "newer" })),
      });
    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps.parts.jobs);
    timer.tick();
    await lost;

    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    expect(fake.calls).toHaveLength(2);
    expect(promptStartSent(fake.calls[1])).toBe(promptStartSent(fake.calls[0]));
    expect((await turnsOf(botId)).map((turn) => turn.promptStartId)).toEqual([start!.id]);
  });
});

describe("a Bot's cache controls (#673)", () => {
  const helperStarter = toolCall({
    name: "start_helper",
    input: { type: "general", task: "Look it up." },
  });
  const isHelperCall = (call: TextOptions) =>
    (call.systemPrompts ?? []).some((prompt) =>
      (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
    );
  const oneHour = { type: "ephemeral", ttl: "1h" };

  it("sends OpenAI's prompt_cache_key per Bot and per Helper, with no retention", async () => {
    const { fake, client, botId } = await botWith([round(helperStarter), round(), round()]);

    await send(client, botId, "hi");

    const [helper] = await getTestDb()
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(eq(botHelper.botId, botId));
    const keyed = fake.calls.filter((call) => call.modelOptions);
    for (const call of keyed) {
      expect(call.modelOptions).toEqual({
        prompt_cache_key: isHelperCall(call) ? `helper:${helper!.id}` : `bot:${botId}`,
      });
    }
    expect(keyed.some(isHelperCall)).toBe(true);
    expect(keyed.some((call) => !isHelperCall(call))).toBe(true);
  });

  it("puts Anthropic's 1-hour breakpoints on a Turn and on a Helper", async () => {
    const { fake, client, botId } = await botWith([round(helperStarter), round(), round()], {
      modelId: "anthropic:claude-sonnet-5-5",
    });

    await send(client, botId, "hi");

    const sent = fake.calls.filter((call) => call.modelOptions);
    expect(sent.some(isHelperCall)).toBe(true);
    for (const call of sent) {
      expect(call.modelOptions).toEqual({ cache_control: oneHour });
      const system = call.systemPrompts as { metadata?: unknown }[];
      expect(system.at(-1)?.metadata).toEqual({ cache_control: oneHour });
      expect(JSON.stringify(system.slice(0, -1))).not.toContain("cache_control");
      expect(JSON.stringify((call.messages as ModelMessage[])[0]?.content)).toContain(
        '"cache_control":{"type":"ephemeral","ttl":"1h"}',
      );
    }
  });
});
