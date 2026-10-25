import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  botCheckIn,
  botHelper,
  botPromptStart,
  botRoutine,
  botSummary,
  botTrigger,
  botTurn,
  job,
  usage,
} from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { findBot } from "../../../../plugins/bot/server/store";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob } from "../../../../plugins/runner/server/jobs/store";
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

const model = "openai:gpt-6-luna";
const planModel = "openai:gpt-6.1-sol";
const silent = { error: () => {} };
type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

// Monday 19 October 2026, 10:00 in London.
const monday = new Date("2026-10-19T09:00:00.000Z");
const minute = 60_000;

/** A round that reports `input` tokens of prompt. */
const reporting = (input: number, played: Round) =>
  withUsage(played as Parameters<typeof withUsage>[0], {
    promptTokens: input,
    completionTokens: 10,
    totalTokens: input + 10,
  });

const say = (words: string, endTurn = false) =>
  round(toolCall({ name: "send_to_user", input: { text: words, endTurn } }));

const prose = "Daanish is planning his week: gym moved to Thursday 07:00.";

/**
 * A Bot "Ada" on an idle runner and a clock the test moves; the Model plays `rounds`. `send` saves a
 * Message and runs its Turn; `runDue()` runs every job due at the clock time. With `hold`, the
 * Model's call number `hold` (from 0) waits until `release()`; `reached` resolves once it waits.
 */
async function botWith({
  rounds,
  linked = false,
  hold,
}: {
  rounds: Round[];
  linked?: boolean;
  hold?: number;
}) {
  const timer = fakeJobClock(monday);
  const fake = createFakeAdapter({ rounds });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reach = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const adapter = {
    ...fake.adapter,
    chatStream: async function* (options: TextOptions) {
      if (fake.calls.length === hold) {
        reach();
        await held;
      }
      yield* fake.adapter.chatStream(options);
    },
  } as typeof fake.adapter;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    jobs,
    adapterFor: () => adapter,
    clock: timer.clock.now,
    ...(linked && { linkedCredentials: async () => ({ apiKey: "chatgpt-access-token" }) }),
  });
  started.push(jobs);
  const user = await insertUser();
  if (!linked) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model: linked ? planModel : model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** Saves the user's Message, without running its Turn. */
  const post = async (words: string) => {
    const stream = await followSend(client, {
      botId,
      id: uuidv7(),
      text: words,
      timeZone: "Europe/London",
    });
    await stream.next();
    await stream.return(undefined);
  };
  /** Saves the user's Message and runs its Turn to the end. */
  const send = async (words: string) => {
    await post(words);
    timer.advance(500);
    await runDue();
  };
  const advance = (ms: number) => timer.advance(ms);
  return {
    fake,
    deps,
    user,
    client,
    botId,
    conversationId,
    runDue,
    post,
    send,
    advance,
    release,
    reached,
  };
}

const awayJobs = (botId: string) =>
  getTestDb()
    .select({ status: job.status, runAfter: job.runAfter })
    .from(job)
    .where(eq(job.idempotencyKey, `summary-away:${botId}`))
    .orderBy(asc(job.createdAt), asc(job.id));

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

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** `value` as stored in jsonb: dates as strings. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("a Summary while the user is away", () => {
  it("is queued 10 minutes after a Turn whose last Step's input was over 100,000 tokens", async () => {
    const { botId, send } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true))],
    });

    await send("plan my week");

    const [turn] = await turnsOf(botId);
    expect(await awayJobs(botId)).toEqual([
      { status: "queued", runAfter: new Date(turn!.endedAt!.getTime() + 10 * minute) },
    ]);
  });

  it("is not queued when the last Step's input was 100,000 tokens or fewer", async () => {
    const { botId, send } = await botWith({
      rounds: [
        reporting(120_000, say("Looking.")),
        reporting(100_000, say("Here's your week.", true)),
      ],
    });

    await send("plan my week");

    expect(await awayJobs(botId)).toEqual([]);
  });

  it("writes the Summary and a new Prompt start, and the next Turn's history starts after it", async () => {
    const { fake, client, botId, send, runDue, advance } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(prose)), round()],
    });
    await send("plan my week");

    advance(10 * minute - 1_000);
    await runDue();
    expect(fake.calls).toHaveLength(1);
    advance(1_000);
    await runDue();

    expect(fake.calls).toHaveLength(2);
    const [first, summaryCall] = fake.calls;
    expect(summaryCall?.threadId).toBe(botId);
    // The same Prompt start, the Turn's input and transcript, then the summarize instruction.
    expect(summaryCall?.systemPrompts).toEqual(first?.systemPrompts);
    expect(summaryCall?.tools).toEqual(first?.tools);
    const [turn] = await turnsOf(botId);
    const sent = messagesOf(summaryCall);
    expect(asJson(sent.slice(0, -1))).toEqual(
      asJson([...messagesOf(first), ...(turn!.transcript as ModelMessage[])]),
    );
    expect(sent.at(-1)?.role).toBe("user");
    expect(String(sent.at(-1)?.content)).toMatch(/summar/i);

    const [summary, ...more] = await summariesOf(botId);
    expect(more).toEqual([]);
    expect(summary).toMatchObject({ kind: "away", turnId: null });
    expect(summary!.text).toContain(prose);
    // The Bot's last Messages to the user, word for word with their times.
    expect(summary!.text).toMatch(/10:00\] Here's your week\./);
    const [oldStart, newStart, ...moreStarts] = await startsOf(botId);
    expect(moreStarts).toEqual([]);
    expect(newStart!.summaryId).toBe(summary!.id);
    expect(newStart!.sections.at(-1)!.text).toContain(summary!.text);
    expect(newStart!.tools).toEqual(oldStart!.tools);
    // The same tool list, deferred tools included, then the Summary.
    expect(oldStart!.sections.at(-1)!.text).toContain("[Deferred tools:");
    const toolsOf = (text: string) => text.slice(text.indexOf("[Your tools]"));
    expect(toolsOf(newStart!.sections.at(-1)!.text)).toContain(
      `${toolsOf(oldStart!.sections.at(-1)!.text)}\n\n[Summary`,
    );

    const [row] = await getTestDb()
      .select({ sourceId: usage.sourceId })
      .from(usage)
      .where(eq(usage.kind, "summary"));
    expect(row).toEqual({ sourceId: botId });

    // The thread's card: the account, and the kept Messages as the Conversation holds them.
    const { summaries, messages } = await client.bot.get({ botId });
    expect(summaries).toEqual([
      {
        id: summary!.id,
        kind: "away",
        at: summary!.createdAt,
        text: prose,
        kept: messages.filter((message) => message.role === "assistant"),
      },
    ]);

    await send("thanks");
    const [, second] = await turnsOf(botId);
    expect(second!.promptStartId).toBe(newStart!.id);
    // Only the new first message and the new Turn's input: the Summary covers the rest.
    expect(messagesOf(fake.calls[2])).toEqual([
      { role: "user", content: newStart!.sections.at(-1)!.text },
      ...second!.input!,
    ]);
    const [hashes] = await getTestDb()
      .select({ promptHashes: usage.promptHashes })
      .from(usage)
      .where(and(eq(usage.kind, "turn"), eq(usage.sourceId, second!.id)));
    expect(hashes!.promptHashes!.filter((entry) => entry.changed)[0]?.changed).toBe("expected");
  });

  it("lists each Summary on bot.get with the Messages it kept, oldest first", async () => {
    const { client, botId, send, runDue, advance } = await botWith({
      rounds: [
        say("Looking into it."),
        reporting(120_000, say("Here's your week.", true)),
        round(text(prose)),
      ],
    });
    await send("plan my week");
    advance(10 * minute);
    await runDue();

    const { summaries } = await client.bot.get({ botId });
    expect(summaries.map((summary) => summary.kept.map((kept) => kept.text))).toEqual([
      ["Looking into it.", "Here's your week."],
    ]);
  });

  it("keeps the whole account on its card when the prose quotes the kept Messages' header", async () => {
    const quoting = `${prose}\n\n[Your last messages to the user, word for word, in UTC]\nA quote.`;
    const { client, botId, send, runDue, advance } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(quoting))],
    });
    await send("plan my week");
    advance(10 * minute);
    await runDue();

    const { summaries } = await client.bot.get({ botId });
    expect(summaries.map((summary) => summary.text)).toEqual([quoting]);
  });

  it("runs on a ChatGPT plan Model too", async () => {
    const { fake, botId, send, runDue, advance } = await botWith({
      linked: true,
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(prose))],
    });
    await send("plan my week");

    advance(10 * minute);
    await runDue();

    expect(fake.calls).toHaveLength(2);
    expect(await summariesOf(botId)).toHaveLength(1);
  });

  it("is cancelled by a Turn starting", async () => {
    const { fake, botId, send, runDue, advance } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round()],
    });
    await send("plan my week");

    advance(5 * minute);
    await send("thanks");
    expect((await awayJobs(botId)).map((row) => row.status)).toEqual(["cancelled"]);
    advance(10 * minute);
    await runDue();

    expect(fake.calls).toHaveLength(2);
    expect(await summariesOf(botId)).toEqual([]);
  });

  type Setup = Awaited<ReturnType<typeof botWith>>;
  const due = (ms: number) => new Date(monday.getTime() + ms);
  /** Background work that wakes the Bot within 50 minutes of the job's run, 10 minutes on. */
  const soon: [string, (setup: Setup, turnId: string) => Promise<unknown>][] = [
    [
      "a Helper is running",
      ({ botId }, turnId) =>
        getTestDb().insert(botHelper).values({
          id: uuidv7(),
          botId,
          type: "general",
          task: "Compare gyms",
          status: "running",
          startedByTurnId: turnId,
          startedAt: monday,
        }),
    ],
    [
      "a Helper is waiting for the user",
      ({ botId }, turnId) =>
        getTestDb().insert(botHelper).values({
          id: uuidv7(),
          botId,
          type: "computer_use",
          task: "Book the dentist",
          status: "waiting",
          startedByTurnId: turnId,
          startedAt: monday,
        }),
    ],
    [
      "a Trigger is queued",
      ({ conversationId }) =>
        getTestDb()
          .insert(botTrigger)
          .values({
            id: `test:${uuidv7()}`,
            conversationId,
            source: "routine",
            channel: "webhook",
            text: "A webhook arrived",
            receivedAt: monday,
          }),
    ],
    [
      "a Check-in is due in 30 minutes",
      ({ botId }, turnId) =>
        getTestDb()
          .insert(botCheckIn)
          .values({
            id: uuidv7(),
            botId,
            at: due(40 * minute),
            note: "Has Acme replied?",
            state: "pending",
            createdByTurnId: turnId,
            createdAt: monday,
            updatedAt: monday,
          }),
    ],
    [
      "a Routine is due in 40 minutes",
      ({ botId }, turnId) =>
        getTestDb()
          .insert(botRoutine)
          .values({
            id: uuidv7(),
            botId,
            name: "gym-reminder",
            prompt: "Remind me about the gym",
            // 10:50 in London, 50 minutes after the Turn.
            schedule: { days: ["mon"], at: "10:50" },
            timeZone: "Europe/London",
            state: "active",
            createdByTurnId: turnId,
            approvedAt: monday,
            createdAt: monday,
            updatedAt: monday,
          }),
    ],
  ];

  it.each(soon)("is skipped when %s", async (_name, arrange) => {
    const setup = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(prose))],
    });
    await setup.send("plan my week");
    const [turn] = await turnsOf(setup.botId);
    await arrange(setup, turn!.id);

    setup.advance(10 * minute);
    await setup.runDue();

    expect(setup.fake.calls).toHaveLength(1);
    expect(await summariesOf(setup.botId)).toEqual([]);
  });

  it("is not skipped by a Check-in due in over 50 minutes", async () => {
    const setup = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(prose))],
    });
    await setup.send("plan my week");
    const [turn] = await turnsOf(setup.botId);
    await getTestDb()
      .insert(botCheckIn)
      .values({
        id: uuidv7(),
        botId: setup.botId,
        at: due(61 * minute),
        note: "Has Acme replied?",
        state: "pending",
        createdByTurnId: turn!.id,
        createdAt: monday,
        updatedAt: monday,
      });

    setup.advance(10 * minute);
    await setup.runDue();

    expect(await summariesOf(setup.botId)).toHaveLength(1);
  });

  it("summarizes a Turn that summarized mid-Turn and then grew past 100,000 tokens again", async () => {
    const { botId, post, runDue, advance, release, reached } = await botWith({
      rounds: [
        reporting(800_000, say("Looking into it now.")),
        // The mid-Turn summary call.
        round(text("The user asked for flights.")),
        reporting(120_000, say("Found three flights.", true)),
        round(text(prose)),
      ],
      hold: 1,
    });
    await post("find me flights");
    advance(500);
    const running = runDue();
    // The Turn works on for a minute after its mid-Turn summary.
    await reached;
    advance(minute);
    release();
    await running;
    expect((await summariesOf(botId)).map((row) => row.kind)).toEqual(["mid_turn"]);

    advance(10 * minute);
    await runDue();

    expect((await summariesOf(botId)).map((row) => row.kind).sort()).toEqual(["away", "mid_turn"]);
  });

  it("ends without a Summary, and without calling again, when the summary call fails", async () => {
    const { fake, botId, send, runDue, advance } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(runError("Overloaded"))],
    });
    await send("plan my week");

    advance(10 * minute);
    await runDue();
    advance(10 * minute);
    await runDue();

    expect(fake.calls).toHaveLength(2);
    expect(await summariesOf(botId)).toEqual([]);
    expect((await awayJobs(botId)).map((row) => row.status)).toEqual(["succeeded"]);
  });

  it("throws its Summary away when a Turn started while it ran", async () => {
    const { botId, runDue, post, send, advance, release, reached } = await botWith({
      rounds: [reporting(120_000, say("Here's your week.", true)), round(text(prose)), round()],
      hold: 1,
    });
    await send("plan my week");

    advance(10 * minute);
    const running = runDue();
    // The summary call waits; meanwhile the user writes again, which starts a Turn.
    await reached;
    await post("one more thing");
    release();
    await running;

    expect(await summariesOf(botId)).toEqual([]);
    expect(await startsOf(botId)).toHaveLength(1);
    // The call it made is still billed.
    expect(
      await getTestDb()
        .select({ sourceId: usage.sourceId })
        .from(usage)
        .where(eq(usage.kind, "summary")),
    ).toEqual([{ sourceId: botId }]);
    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(2);
    expect(
      await getTestDb()
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            eq(job.idempotencyKey, `summary-away:${botId}`),
            inArray(job.status, ["queued", "running"]),
          ),
        ),
    ).toEqual([]);
  });
});
