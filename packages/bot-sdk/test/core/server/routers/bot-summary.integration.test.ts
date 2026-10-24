import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { botPromptStart, botSummary, botTurn, job, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob, reapStaleJobs } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import {
  createFakeAdapter,
  round,
  runError,
  text,
  toolCall,
  withUsage,
} from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { followSend } from "../../../support/follow-send";

/** Its context window is 1,050,000 tokens in the models snapshot, so 75% is 787,500. */
const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = ReturnType<typeof round>;

const now = new Date("2030-03-15T12:00:00Z");

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const note = "[Your earlier work on this Turn is in the Summary.]";

/** A round that reports `input` tokens of prompt. */
const reporting = (input: number, played: Round) =>
  withUsage(played, { promptTokens: input, completionTokens: 10, totalTokens: input + 10 });

const say = (words: string, endTurn = false) =>
  round(toolCall({ name: "send_to_user", input: { text: words, endTurn } }));

/** A user with an OpenAI key and a Bot "Ada", over an SDK whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
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
    plugins: [bot()],
    memory: false,
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
  return { fake, client, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, words: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: words })) {
    // Read to the end of the Turn.
  }
}

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
const contentOf = (entry: ModelMessage | undefined) => String(entry?.content ?? "");

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

const startsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botPromptStart)
    .where(eq(botPromptStart.botId, botId))
    .orderBy(asc(botPromptStart.builtAt), asc(botPromptStart.id));

const summariesOf = (botId: string) =>
  getTestDb().select().from(botSummary).where(eq(botSummary.botId, botId));

describe("a Turn that nears the context window", () => {
  it("summarizes before its next Step, then carries on from a new Prompt start", async () => {
    const { fake, client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      // The summary call.
      reporting(800_100, round(text("The user asked Ada to research flights."))),
      say("Found three flights.", true),
    ]);

    await send(client, botId, "find me flights");

    expect(fake.calls).toHaveLength(3);
    const [first, summaryCall, after] = fake.calls;
    // The summary call sends the same Prompt start and history, then the summarize instruction.
    expect(summaryCall?.systemPrompts).toEqual(first?.systemPrompts);
    expect(summaryCall?.tools).toEqual(first?.tools);
    const sent = messagesOf(summaryCall);
    expect(sent.slice(0, messagesOf(first).length)).toEqual(messagesOf(first));
    expect(sent.at(-1)?.role).toBe("user");
    expect(contentOf(sent.at(-1))).toMatch(/summar/i);

    const [turn] = await turnsOf(botId);
    const [summary, ...moreSummaries] = await summariesOf(botId);
    expect(moreSummaries).toEqual([]);
    expect(summary).toMatchObject({ kind: "mid_turn", turnId: turn!.id });
    expect(summary!.text).toContain("The user asked Ada to research flights.");
    // The Bot's last Messages to the user, word for word with their times.
    expect(summary!.text).toMatch(/12:00.*Looking into it now\./);

    const [oldStart, newStart, ...moreStarts] = await startsOf(botId);
    expect(moreStarts).toEqual([]);
    expect(oldStart!.summaryId).toBeNull();
    expect(newStart!.summaryId).toBe(summary!.id);
    const newFirst = newStart!.sections.at(-1)!.text;
    expect(newFirst).toContain(summary!.text);
    // The Turn keeps the Prompt start it started with.
    expect(turn!.promptStartId).toBe(oldStart!.id);

    // The Turn carries on: the new first message, its own input word for word, then the note.
    const resumed = messagesOf(after);
    expect(contentOf(resumed[0])).toBe(newFirst);
    expect(resumed.slice(1, 1 + turn!.input!.length)).toEqual(turn!.input);
    expect(resumed[1 + turn!.input!.length]).toEqual({ role: "user", content: note });
    expect(resumed).toHaveLength(turn!.input!.length + 2);

    // The transcript keeps every Step.
    const transcript = JSON.stringify(turn!.transcript);
    expect(transcript).toContain("Looking into it now.");
    expect(transcript).toContain("Found three flights.");
    expect(turn!.status).toBe("complete");

    const rows = await getTestDb()
      .select({ kind: usage.kind, sourceId: usage.sourceId, promptHashes: usage.promptHashes })
      .from(usage)
      .where(inArray(usage.kind, ["turn", "summary"]))
      .orderBy(asc(usage.createdAt), asc(usage.id));
    expect(rows.map((row) => [row.kind, row.sourceId])).toEqual([
      ["turn", turn!.id],
      ["summary", turn!.id],
      ["turn", turn!.id],
    ]);
    // The first Step after the Summary sends a new Prompt start: an expected change.
    const changed = rows[2]!.promptHashes!.filter((entry) => entry.changed);
    expect(changed.map((entry) => entry.changed)).toEqual(["expected"]);
  });

  it("counts the summary call in the Turn's usage and shows it in the Turn's chip", async () => {
    const { client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      reporting(800_100, round(text("The user asked Ada to research flights."))),
      say("Found three flights.", true),
    ]);

    await send(client, botId, "find me flights");

    const [turn] = await turnsOf(botId);
    const rows = await getTestDb()
      .select({ id: usage.id, kind: usage.kind, inputTokens: usage.inputTokens })
      .from(usage)
      .where(eq(usage.sourceId, turn!.id))
      .orderBy(asc(usage.createdAt), asc(usage.id));
    expect(turn!.usage!.input).toBe(rows.reduce((sum, row) => sum + row.inputTokens, 0));
    const { turns } = await client.bot.get({ botId });
    expect(turns[0]!.steps.map((step) => [step.id, step.kind])).toEqual(
      rows.map((row) => [row.id, row.kind]),
    );
  });

  it("does not summarize while the previous Step stays under 75% of the context window", async () => {
    const { fake, client, botId } = await botWith([
      reporting(787_000, say("Looking into it now.")),
      say("Found three flights.", true),
    ]);

    await send(client, botId, "find me flights");

    expect(fake.calls).toHaveLength(2);
    expect(await summariesOf(botId)).toEqual([]);
    expect(await startsOf(botId)).toHaveLength(1);
  });

  it("starts the next Turn's history after the Summary, from the note on", async () => {
    const { fake, client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      round(text("The user asked Ada to research flights.")),
      say("Found three flights.", true),
      round(),
    ]);

    await send(client, botId, "find me flights");
    await send(client, botId, "thanks");

    const [last, next] = [fake.calls[2], fake.calls[3]];
    const [, newStart] = await startsOf(botId);
    const [turn, second] = await turnsOf(botId);
    expect(second!.promptStartId).toBe(newStart!.id);
    const sent = messagesOf(next);
    // What the last call sent, then its Step's reply and result, then the new Turn's input.
    expect(sent.slice(0, messagesOf(last).length)).toEqual(messagesOf(last));
    expect(sent.slice(-second!.input!.length)).toEqual(second!.input);
    expect(JSON.stringify(sent)).not.toContain('Looking into it now.","endTurn');
    expect(JSON.stringify(sent)).toContain("Found three flights.");
    expect(turn!.transcript?.length).toBeGreaterThan(0);

    const hashes = await getTestDb()
      .select({ promptHashes: usage.promptHashes })
      .from(usage)
      .where(and(eq(usage.kind, "turn"), eq(usage.sourceId, second!.id)));
    expect(hashes[0]!.promptHashes!.filter((entry) => entry.changed)).toEqual([]);
  });

  it("names the next Turn's new first message as expected when the Turn ended right after its Summary", async () => {
    const { client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      round(text("The user asked Ada to research flights.")),
      round(runError("Overloaded")),
      round(),
    ]);

    await send(client, botId, "find me flights");
    await send(client, botId, "thanks");

    const [, second] = await turnsOf(botId);
    const [row] = await getTestDb()
      .select({ promptHashes: usage.promptHashes })
      .from(usage)
      .where(and(eq(usage.kind, "turn"), eq(usage.sourceId, second!.id)));
    expect(
      row!
        .promptHashes!.filter((entry) => entry.changed)
        .map(({ name, changed }) => [name, changed]),
    ).toEqual([["first_message", "expected"]]);
  });

  it("ends the Turn with the Model's error when the summary call fails", async () => {
    const { fake, client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      round(runError("Prompt is too long")),
    ]);

    await send(client, botId, "find me flights");

    expect(fake.calls).toHaveLength(2);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "Prompt is too long" });
    expect(await summariesOf(botId)).toEqual([]);
  });

  it("carries on without a Summary when the summary call writes none", async () => {
    const { fake, client, botId } = await botWith([
      reporting(800_000, say("Looking into it now.")),
      reporting(800_100, say("Still looking.")),
      say("Found three flights.", true),
    ]);

    await send(client, botId, "find me flights");

    expect(await summariesOf(botId)).toEqual([]);
    expect(await startsOf(botId)).toHaveLength(1);
    // The Step after it sends what it would have, with no note.
    expect(messagesOf(fake.calls[2]).slice(0, messagesOf(fake.calls[0]).length)).toEqual(
      messagesOf(fake.calls[0]),
    );
    expect(JSON.stringify(fake.calls[2]?.messages)).not.toContain(note);
    const [usageRow] = await getTestDb()
      .select({ kind: usage.kind })
      .from(usage)
      .where(eq(usage.kind, "summary"));
    expect(usageRow).toBeDefined();
  });
});

describe("a Turn that crashes after its Summary", () => {
  beforeEach(async () => {
    await getTestDb()
      .update(job)
      .set({ status: "cancelled" })
      .where(inArray(job.status, ["queued", "running"]));
  });

  it("replays the saved Summary without a second summary call", async () => {
    const fake = createFakeAdapter({
      rounds: [
        reporting(800_000, say("Looking into it now.")),
        round(text("The user asked Ada to research flights.")),
        // Cut off by the crash, then made again by the resumed attempt.
        say("Found three flights.", true),
        say("Found three flights.", true),
      ],
      manual: true,
    });
    const timer = fakeJobClock(now);
    const runners = new Map<TestDeps, InProcessRunner>();
    const instance = () => {
      let deps: TestDeps | undefined;
      const jobs = inProcessRunner({
        db: getTestDb(),
        logger: silent,
        clock: timer.clock,
        drainMs: 1_000,
        deps: () => deps!,
      });
      started.push(jobs);
      deps = createTestSdk({
        plugins: [bot()],
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
    const { id: botId } = await client.bot.create({ name: "Ada", model });
    await followSend(client, { botId, id: uuidv7(), text: "find me flights" });

    const lost = attempt(deps);
    // The first Step and the Summary are saved, and the attempt waits in its third model call.
    // Five chunks each: the first Step, then the summary call.
    await fake.release(10);
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBe(3);
    await expect.poll(async () => (await summariesOf(botId)).length, { timeout: 10_000 }).toBe(1);
    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
    timer.tick();
    await lost;

    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    // The resumed attempt makes only the Step the crash cut off.
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[3]?.messages).toEqual(fake.calls[2]?.messages);
    expect(await summariesOf(botId)).toHaveLength(1);
    expect(await startsOf(botId)).toHaveLength(2);
    const rows = await getTestDb()
      .select({ kind: usage.kind })
      .from(usage)
      .where(eq(usage.kind, "summary"));
    expect(rows).toHaveLength(1);
    const [turn] = await turnsOf(botId);
    expect(turn!.status).toBe("complete");
  });
});
