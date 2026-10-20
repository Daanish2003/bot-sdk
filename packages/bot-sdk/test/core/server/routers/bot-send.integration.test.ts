import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHookEmitter } from "../../../../core/server/chat/hooks";
import { createMemoryPubSub, type PubSub } from "../../../../core/server/chat/pubsub";
import {
  botTrigger,
  botTurn,
  conversation,
  job,
  message,
  usage,
} from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { Transaction } from "../../../../core/server/plugin";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { appendMessage } from "../../../../core/server/chat/message-tree";
import { bot } from "../../../../plugins/bot/server/plugin";
import { receive } from "../../../../plugins/bot/server/router";
import { turnTimeLimitMs } from "../../../../plugins/bot/server/store";
import { findBot, newestTimeZone, textParts } from "../../../../plugins/bot/server/store";
import { sendToBot } from "../../../../plugins/bot/server/turn";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { quotaLookup } from "../../../../plugins/models/server/quota";
import {
  inProcessRunner,
  type InProcessRunner,
  type JobClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import type { JobRunner } from "../../../../plugins/runner/server/jobs/runner";
import { claimJob, reapStaleJobs } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
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

const model = "openai:gpt-5.6";
const sendToUser = "send_to_user";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const silent = { error: () => {} };

/** The runners the tests started, stopped after each test. */
const started: InProcessRunner[] = [];

/** The subscriptions on the tests' Pub/Sub that are still open: one per stream a send is following. */
let openFollowers = 0;

/** `pubsub`, counting its open subscriptions in `openFollowers`. */
function countingPubSub(pubsub: PubSub): PubSub {
  return {
    publish: (channel, message) => pubsub.publish(channel, message),
    async subscribe(channel, handler) {
      const unsubscribe = await pubsub.subscribe(channel, handler);
      openFollowers++;
      let open = true;
      return async () => {
        if (open) openFollowers--;
        open = false;
        await unsubscribe();
      };
    },
  };
}

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
  // A stream a test leaves open keeps following its Turn, and a hint or its 2 s re-read wakes it to
  // query; one the test closes follows until the abort reaches the server. Those queries must end
  // before the next test truncates the tables.
  await expect.poll(() => openFollowers, { timeout: 5_000 }).toBeLessThanOrEqual(followersBefore);
});

/** The open subscriptions as the test starts: one a failed test leaked must not fail the rest. */
let followersBefore = 0;
beforeEach(() => {
  followersBefore = openFollowers;
});

/**
 * A Bot-enabled SDK over `overrides`, whose in-process runner runs the Turns' jobs. It is started
 * and stopped after the test; it drains for only 50 ms, so a Turn a test leaves hanging is aborted.
 */
async function sdkWithRunner(
  overrides: TestDepsOverrides,
  { idle = false, jobClock }: { idle?: boolean; jobClock?: JobClock } = {},
) {
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: jobClock,
    deps: () => deps!,
  });
  const pubsub = countingPubSub(overrides.pubsub ?? createMemoryPubSub());
  deps = createTestSdk({ plugins: [bot()], jobs, ...overrides, pubsub });
  // An idle runner never claims a job, so a Turn stays queued.
  if (!idle) await jobs.start();
  started.push(jobs);
  return { deps, jobs };
}

/** A user with an OpenAI key, a Bot on `model`, and a client over a Bot-enabled SDK whose Model plays `rounds`. */
async function botWith(
  rounds: Round[],
  {
    manual = false,
    pubsub,
    clock,
    idle = false,
    jobClock,
  }: { manual?: boolean; idle?: boolean; jobClock?: JobClock } & Pick<
    TestDepsOverrides,
    "pubsub" | "clock"
  > = {},
) {
  const fake = createFakeAdapter({ rounds, manual });
  const { deps, jobs } = await sdkWithRunner(
    { adapterFor: () => fake.adapter, pubsub, clock },
    { idle, jobClock },
  );
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({ name: "Ada", model });
  return { fake, deps, jobs, client, user, botId: created.id };
}

const hostModel = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens, $0.30 read from the cache, $6 written to it and $15 per 1M output tokens,
// so a token costs as many micros as its price.
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
        cacheReadUsdPerMillion: 0.3,
        cacheWriteUsdPerMillion: 6,
      },
    ],
  },
];

/** A user with no key of their own, and a Bot on the Host's Model. */
async function hostBotWith(rounds: Round[], overrides: Pick<TestDepsOverrides, "getQuota"> = {}) {
  const fake = createFakeAdapter({ rounds });
  const { deps } = await sdkWithRunner({
    hostProviders,
    adapterFor: () => fake.adapter,
    ...overrides,
  });
  const user = await insertUser();
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({ name: "Ada", model: hostModel });
  return { fake, client, user, botId: created.id };
}

const usageOf = (userId: string) =>
  getTestDb().select().from(usage).where(eq(usage.userId, userId));

/** A `running` Turn row of `botId`. */
async function insertRunningTurn(botId: string) {
  const id = uuidv7();
  await getTestDb()
    .insert(botTurn)
    .values({ id, botId, status: "running", startedAt: new Date(Date.now() - 2 * 60_000) });
  return id;
}

/** Reads `stream` until `until` holds for an event, and returns the events read. */
async function readUntil<T>(stream: AsyncIterator<T>, until: (event: T) => boolean) {
  const events: T[] = [];
  for (let next = await stream.next(); !next.done; next = await stream.next()) {
    events.push(next.value);
    if (until(next.value)) break;
  }
  return events;
}

/** Waits for the Turn to leave `running`, and returns its row. */
async function endedTurn(turnBotId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [turn] = await turnsOf(turnBotId);
    if (turn && turn.status !== "running") return turn;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The Turn never ended");
}

/** Sends `text` to the Bot and reads the whole stream. */
async function send(
  client: ReturnType<typeof chatRpc>,
  botId: string,
  text: string,
  id = uuidv7(),
) {
  const events = [];
  for await (const event of await client.bot.send({ botId, id, text })) events.push(event);
  return events;
}

/**
 * Sends `text` and reads only the saved Message, which it returns, then leaves the stream. A stream
 * left open keeps following the Turn, and its queries can still run when the next test truncates
 * the tables. Closing it is not enough: the follow ends only once it next yields, which a Turn that
 * keeps running may never do. Aborting the request ends it at once.
 */
async function sendSaved(
  client: ReturnType<typeof chatRpc>,
  botId: string,
  text: string,
  { id = uuidv7(), timeZone }: { id?: string; timeZone?: string } = {},
) {
  const leave = new AbortController();
  try {
    const stream = await client.bot.send({ botId, id, text, timeZone }, { signal: leave.signal });
    const saved = await stream.next();
    return saved.done ? undefined : saved.value;
  } finally {
    leave.abort();
  }
}

/** The stream's events, with each Message cut down to its role and text. */
const shapes = (events: Awaited<ReturnType<typeof send>>) =>
  events.map((event) =>
    event.type === "message"
      ? { type: "message", role: event.message.role, text: event.message.text }
      : event,
  );

const sends = (input: { text: string; endTurn: boolean }) => toolCall({ name: sendToUser, input });

async function turnsOf(botId: string) {
  return getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
}

/** The Conversation's Triggers, in the order they were received. */
async function triggersOf(conversationId: string) {
  return getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.conversationId, conversationId))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));
}

/** A user Message's content without the time note that opens the newest one. */
const withoutNotice = (content: unknown) =>
  String(content).replace(/^\[Current time: [^\]]*\]\n\n/, "");

/** The model input of one call: its messages after the Prompt start's first message, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) =>
  ((call?.messages ?? []) as ModelMessage[]).slice(1);

/**
 * Saves a user Message and hands its Trigger to the Router directly, as a later wake source would:
 * it waits in the Conversation queue instead of interrupting the running Turn. Returns its id.
 */
async function queueTrigger(deps: TestDeps, conversationId: string, text: string) {
  return getTestDb().transaction(async (tx) => {
    const row = await appendMessage(tx, conversationId, {
      role: "user",
      parts: textParts(text),
      status: "complete",
      createdAt: deps.clock(),
    });
    await receive(deps, tx, {
      id: row.id,
      conversationId,
      source: "user",
      channel: "web",
      messageId: row.id,
      receivedAt: deps.clock(),
    });
    return row.id;
  });
}

describe("bot.send", () => {
  it("keeps a reply with no tool call private: zero Messages, a complete Turn, its text in the transcript", async () => {
    const { client, botId } = await botWith([round(text("Nothing to add here.")), round()]);

    const events = await send(client, botId, "ok");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "ok" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect((await client.bot.get({ botId })).messages.map((row) => row.role)).toEqual(["user"]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete" });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(turn?.transcript)).toContain("Nothing to add here.");
    // The reminder Step answered with no text, so the reminder is the transcript's last entry.
    expect(turn?.transcript?.map((entry) => entry.role)).toEqual(["assistant", "user"]);
    expect(String(turn?.transcript?.at(-1)?.content)).toMatch(/not delivered/i);
  });

  it("appends one Message per SendToUser call, never the Model's plain text", async () => {
    const { client, botId } = await botWith([
      round(text("Thinking privately."), sends({ text: "Hello!", endTurn: true })),
    ]);

    const events = await send(client, botId, "hi");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
    const { messages } = await client.bot.get({ botId });
    expect(messages.map((row) => [row.role, row.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello!"],
    ]);
    // Each streamed Message is the saved one.
    expect(events.slice(0, 2).map((event) => event.type === "message" && event.message)).toEqual(
      messages,
    );
  });

  it("ends the Turn on endTurn: true with no further model call", async () => {
    // Only one round is scripted: another model call would fail the Turn.
    const { client, botId, fake } = await botWith([round(sends({ text: "Done.", endTurn: true }))]);

    const events = await send(client, botId, "do it");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(fake.calls).toHaveLength(1);
  });

  it("streams several sends of one Step in order, each its own Message", async () => {
    const { client, botId } = await botWith([
      round(
        sends({ text: "One", endTurn: false }),
        sends({ text: "Two", endTurn: false }),
        sends({ text: "Three", endTurn: true }),
      ),
    ]);

    const events = await send(client, botId, "count to three");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "count to three" },
      { type: "message", role: "assistant", text: "One" },
      { type: "message", role: "assistant", text: "Two" },
      { type: "message", role: "assistant", text: "Three" },
      { type: "turnEnded", status: "complete" },
    ]);
  });

  it("answers an empty text with an error saying what to do, and appends nothing", async () => {
    const { client, botId, fake } = await botWith([
      round(sends({ text: "  ", endTurn: true })),
      round(),
    ]);

    const events = await send(client, botId, "hm");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hm" },
      { type: "turnEnded", status: "complete" },
    ]);
    // The Model read the error and got its next Step.
    const result = inputOf(fake.calls[1]).find((message) => message.role === "tool");
    expect(String(result?.content)).toMatch(/text.*empty|empty.*text/i);
    expect(String(result?.content)).toMatch(/reply with no text and no tool call/i);
  });

  it("replays earlier Turns' transcripts as the next Turn's input, after the fixed system prompt", async () => {
    const { client, botId, fake } = await botWith([
      round(text("Private note."), sends({ text: "Hello!", endTurn: true })),
      round(text("Quiet now.")),
    ]);

    await send(client, botId, "hi");
    await send(client, botId, "thanks");

    const second = fake.calls[1];
    expect(JSON.stringify(second?.systemPrompts)).toContain("send_to_user");
    const input = inputOf(second);
    expect(input.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(input[0]).toMatchObject({ role: "user" });
    expect(withoutNotice(input[0]?.content)).toBe("hi");
    // The Model sees its send as a SendToUser call, never as plain assistant text.
    expect(input[1]?.toolCalls?.map((call) => call.function.name)).toEqual([sendToUser]);
    expect(JSON.parse(input[1]?.toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
      text: "Hello!",
      endTurn: true,
    });
    expect(input[1]?.content).toBe("Private note.");
    expect(input[3]).toMatchObject({ role: "user" });
    expect(withoutNotice(input[3]?.content)).toBe("thanks");
  });

  it("only adds to history: the input sent to Turn N+1 starts with exactly Turn N's input and transcript", async () => {
    const { client, botId, fake } = await botWith([
      round(text("Private note."), sends({ text: "Hello!", endTurn: true })),
      round(sends({ text: "Noted.", endTurn: true })),
      round(text("Quiet now.")),
    ]);

    await send(client, botId, "hi");
    await send(client, botId, "remember the milk");
    await send(client, botId, "thanks");

    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(3);
    // Each Turn stores the newest message exactly as it sent it, with its time.
    // As JSON, the way it is stored and sent: the adapter gets each message's createdAt as a Date.
    const asSent = (call: TextOptions | undefined) => JSON.parse(JSON.stringify(inputOf(call)));
    for (const [index, turn] of turns.entries()) {
      const sent = asSent(fake.calls[index]);
      const before = turns
        .slice(0, index)
        .flatMap((earlier) => [...(earlier.input ?? []), ...(earlier.transcript ?? [])]);
      expect(sent.slice(0, before.length)).toEqual(before);
      expect(sent.slice(before.length)).toEqual(turn.input);
      expect(String(turn.input?.at(-1)?.content)).toMatch(/^\[Current time: /);
    }
    // The earlier time notes stay, byte for byte.
    expect(asSent(fake.calls[2]).slice(0, inputOf(fake.calls[1]).length)).toEqual(
      asSent(fake.calls[1]),
    );
  });

  it("gives another user not-found for a Bot that isn't theirs", async () => {
    const { botId, deps } = await botWith([]);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.send({ botId, id: uuidv7(), text: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("a Step that ends in plain text", () => {
  /** The note the Turn adds after an undelivered plain-text Step, from a model call's input. */
  const reminderIn = (call: TextOptions | undefined) => inputOf(call).at(-1);

  it("gets one reminder Step, and the reply that Step sends reaches the user", async () => {
    const { client, botId, fake } = await botWith([
      round(text("I can't book meetings.")),
      round(sends({ text: "I can't book meetings.", endTurn: true })),
    ]);

    const events = await send(client, botId, "Book the meeting for Thursday");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "Book the meeting for Thursday" },
      { type: "message", role: "assistant", text: "I can't book meetings." },
      { type: "turnEnded", status: "complete" },
    ]);
    expect(fake.calls).toHaveLength(2);
    const reminder = reminderIn(fake.calls[1]);
    expect(reminder?.role).toBe("user");
    expect(String(reminder?.content)).toMatch(/not delivered/i);
    expect(String(reminder?.content)).toContain(sendToUser);
    expect(String(reminder?.content)).toMatch(/no text/i);
    // The reminder stays in the saved transcript, so the next Turn's history is honest.
    const [turn] = await turnsOf(botId);
    expect(turn?.transcript?.map((entry) => entry.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "tool",
    ]);
    expect(turn?.transcript?.[1]).toMatchObject({ content: reminder?.content });
  });

  it("gets the reminder after the Turn already sent Messages", async () => {
    const { client, botId, fake } = await botWith([
      round(sends({ text: "Here it is.", endTurn: false })),
      round(text("That should do it.")),
      round(),
    ]);

    const events = await send(client, botId, "hi");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(fake.calls).toHaveLength(3);
    expect(String(reminderIn(fake.calls[2])?.content)).toMatch(/not delivered/i);
  });

  it("ends the Turn complete and quiet when the Step after the reminder is plain text again", async () => {
    // Only two rounds are scripted: a second reminder would fail the Turn.
    const { client, botId, fake } = await botWith([
      round(text("Nothing to add here.")),
      round(text("Still nothing.")),
    ]);

    const events = await send(client, botId, "ok");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "ok" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect(fake.calls).toHaveLength(2);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", error: null });
    expect(JSON.stringify(turn?.transcript)).toContain("Still nothing.");
  });

  it("gets no reminder for a Step with no text and no tool call", async () => {
    const { client, botId, fake } = await botWith([round(text("  ")), round()]);

    const events = await send(client, botId, "ok");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(fake.calls).toHaveLength(1);
  });

  it("counts the reminder Step toward the 10-Step limit", async () => {
    const more = round(sends({ text: "More", endTurn: false }));
    const { client, botId, fake } = await botWith([
      round(text("Thinking out loud.")),
      ...Array.from({ length: 10 }, () => more),
    ]);

    await send(client, botId, "go on forever");

    expect(fake.calls).toHaveLength(10);
    expect(
      (await client.bot.get({ botId })).messages.filter((row) => row.role === "assistant"),
    ).toHaveLength(9);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "step_limit" });
  });

  it("skips the reminder when plain text ends the tenth Step, and ends the Turn quiet and complete", async () => {
    const more = round(sends({ text: "More", endTurn: false }));
    const { client, botId, fake } = await botWith([
      ...Array.from({ length: 9 }, () => more),
      round(text("Done, I think.")),
      round(sends({ text: "Too late", endTurn: true })),
    ]);

    const events = await send(client, botId, "go on");

    expect(fake.calls).toHaveLength(10);
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", error: null });
    expect(JSON.stringify(turn?.transcript)).not.toMatch(/not delivered/i);
  });
});

describe("a Turn's limits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after 10 Steps with error / step_limit, and its Messages stay", async () => {
    // A Model that never ends its Turn: one more round is scripted than the limit allows.
    const rounds = Array.from({ length: 11 }, (_, step) =>
      round(sends({ text: `Step ${step + 1}`, endTurn: false })),
    );
    const { client, botId, fake } = await botWith(rounds);

    const events = await send(client, botId, "go on forever");

    expect(fake.calls).toHaveLength(10);
    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "error" });
    const { messages } = await client.bot.get({ botId });
    expect(messages.filter((row) => row.role === "assistant").map((row) => row.text)).toEqual(
      Array.from({ length: 10 }, (_, step) => `Step ${step + 1}`),
    );
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "step_limit" });
  });

  it("ends a Turn past 5 minutes with error / timed_out, and its Messages stay", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { client, botId, fake } = await botWith([first, round(text("Never comes."))], {
      manual: true,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const stream = await client.bot.send({ botId, id: uuidv7(), text: "take your time" });
    await fake.release(first.length);
    const before = await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    // The second Step hangs; the clock passes the limit.
    await vi.advanceTimersByTimeAsync(turnTimeLimitMs);
    const after = await readUntil(stream, () => false);
    vi.useRealTimers();

    expect(shapes([...before, ...after]).at(-1)).toEqual({ type: "turnEnded", status: "error" });
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "take your time",
      "On it…",
    ]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "timed_out" });
  });
});

describe("a Turn off the request", () => {
  it("keeps running after the client disconnects, and its Messages are saved", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { client, botId, fake } = await botWith(
      [first, round(sends({ text: "Done.", endTurn: true }))],
      { manual: true },
    );
    const abort = new AbortController();

    const stream = await client.bot.send(
      { botId, id: uuidv7(), text: "hi" },
      { signal: abort.signal },
    );
    await fake.release(first.length);
    await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    abort.abort();
    await stream.return?.(undefined).catch(() => {});
    await fake.releaseAll();

    expect(await endedTurn(botId)).toMatchObject({ status: "complete", error: null });
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "hi",
      "On it…",
      "Done.",
    ]);
  });

  it("keeps running when its stream is left before it is read", async () => {
    const { deps, user, client, botId } = await botWith([
      round(sends({ text: "Back.", endTurn: true })),
    ]);

    // The transport may drop a stream it never pulled from: `return()` before any `next()`.
    const stream = await sendToBot(deps, { userId: user.id, botId, id: uuidv7(), text: "hi" });
    await stream.return(undefined);

    expect(await endedTurn(botId)).toMatchObject({ status: "complete", error: null });
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "hi",
      "Back.",
    ]);
  });

  it("links the Turn to the job that runs it", async () => {
    const { client, botId } = await botWith([round(text("Quiet."))]);

    await send(client, botId, "hi");

    const [turn] = await turnsOf(botId);
    // The stream ends with the Turn's last Checkpoint; the runner marks the job succeeded only
    // after its run returns, so the test waits for that write.
    await expect
      .poll(async () => (await getTestDb().select().from(job).where(eq(job.id, turn!.jobId!)))[0])
      .toMatchObject({ name: "bot.turn", payload: { turnId: turn!.id }, status: "succeeded" });
  });

  it("follows the Turn on its 2 s re-read when a hint is lost", async () => {
    const quiet = createMemoryPubSub();
    // A pub/sub that drops every hint: only the re-read sees the Turn's Messages and its end.
    const { client, botId } = await botWith([round(sends({ text: "Hello!", endTurn: true }))], {
      pubsub: { publish: async () => {}, subscribe: quiet.subscribe },
    });

    const events = await send(client, botId, "hi");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
  });
});

describe("bot.stop", () => {
  it("ends a queued Turn stopped at once, and its job never runs", async () => {
    const { client, botId, fake } = await botWith([round(text("Never."))], { idle: true });
    await sendSaved(client, botId, "hi");

    await client.bot.stop({ botId });

    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    const [row] = await getTestDb().select().from(job).where(eq(job.id, turn!.jobId!));
    expect(row).toMatchObject({ status: "cancelled", attempts: 0 });
    expect(fake.calls).toHaveLength(0);
    expect((await client.bot.get({ botId })).bot.turnStatus).toBe("stopped");
  });

  it("ends a running Turn stopped as its attempt aborts, and the Messages already sent stay", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { client, botId, fake } = await botWith(
      [first, round(sends({ text: "Never sent.", endTurn: true }))],
      { manual: true },
    );
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "hi" });
    await fake.release(first.length);
    await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );

    await client.bot.stop({ botId });
    await fake.releaseAll();

    expect(await endedTurn(botId)).toMatchObject({ status: "stopped", error: null });
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "hi",
      "On it…",
    ]);
    const rest = await readUntil(stream, () => false);
    expect(rest.at(-1)).toEqual({ type: "turnEnded", status: "stopped" });
  });

  it("does nothing when no Turn is running", async () => {
    const { client, botId } = await botWith([]);

    await client.bot.stop({ botId });

    expect(await turnsOf(botId)).toEqual([]);
  });

  it("refuses another user's Bot as not found", async () => {
    const { botId, deps } = await botWith([]);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.stop({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stopTurns, on a Ban, ends the running Turn of each of the user's Bots stopped", async () => {
    const { client, deps, user, botId, fake } = await botWith([], { idle: true });
    const { id: otherBotId } = await client.bot.create({ name: "Grace", model });
    for (const id of [botId, otherBotId]) await sendSaved(client, id, "hi");

    await deps.plugin("bot").stopTurns(user.id);

    for (const id of [botId, otherBotId]) {
      expect(await turnsOf(id)).toMatchObject([{ status: "stopped", error: null }]);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("one Turn at a time", () => {
  it("has the next Turn take every Trigger that waited while a Turn ran, in the order they were received", async () => {
    const { client, deps, user, botId, fake } = await botWith([round(), round()], { manual: true });
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const firstStream = await client.bot.send({ botId, id: uuidv7(), text: "one" });
    await firstStream.next();
    await expect.poll(() => fake.calls.length).toBe(1);
    const two = await queueTrigger(deps, conversationId, "two");
    const three = await queueTrigger(deps, conversationId, "three");
    const [firstTurn] = await turnsOf(botId);
    expect(await triggersOf(conversationId)).toMatchObject([
      { turnId: firstTurn!.id },
      { id: two, turnId: null },
      { id: three, turnId: null },
    ]);

    await fake.releaseAll();
    expect((await readUntil(firstStream, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
    await expect
      .poll(async () => (await turnsOf(botId)).map((turn) => turn.status))
      .toEqual(["complete", "complete"]);

    const turns = await turnsOf(botId);
    const taken = await triggersOf(conversationId);
    expect(taken.map((row) => row.turnId)).toEqual([turns[0]!.id, turns[1]!.id, turns[1]!.id]);
    expect(fake.calls).toHaveLength(2);
    const users = inputOf(fake.calls[1]).filter((entry) => entry.role === "user");
    expect(users.map((entry) => withoutNotice(entry.content))).toEqual(["one", "two", "three"]);
  });

  it("starts the next Turn when the running one ends error", async () => {
    const { client, deps, user, botId, fake } = await botWith(
      [round(runError("Provider down")), round()],
      { manual: true },
    );
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await sendSaved(client, botId, "one");
    await expect.poll(() => fake.calls.length).toBe(1);
    await queueTrigger(deps, conversationId, "two");

    await fake.releaseAll();

    await expect
      .poll(async () => (await turnsOf(botId)).map((turn) => turn.status))
      .toEqual(["error", "complete"]);
  });

  it("refuses a second running Turn for one Bot by its index", async () => {
    const { botId } = await botWith([]);
    await insertRunningTurn(botId);

    await expect(insertRunningTurn(botId)).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("reads a running Turn as running in bot.get and bot.list, however old", async () => {
    const { client, botId } = await botWith([]);
    await insertRunningTurn(botId);

    expect((await client.bot.get({ botId })).bot.turnStatus).toBe("running");
    expect((await client.bot.list()).find((listed) => listed.id === botId)?.turnStatus).toBe(
      "running",
    );
  });
});

describe("skipping the line", () => {
  const userTexts = (call: TextOptions | undefined) =>
    inputOf(call)
      .filter((entry) => entry.role === "user")
      .map((entry) => withoutNotice(entry.content));

  it("interrupts a running Turn: it ends stopped and keeps its sent Messages, and a new Turn takes the Message with its transcript in view", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { client, user, botId, fake } = await botWith(
      [
        first,
        round(sends({ text: "Wednesday it is.", endTurn: true })),
        round(sends({ text: "Thursday it is.", endTurn: true })),
      ],
      { manual: true },
    );
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const firstStream = await client.bot.send({
      botId,
      id: uuidv7(),
      text: "Book the meeting for Wednesday",
    });
    await fake.release(first.length);
    await readUntil(
      firstStream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    // Step 1 is saved, and the Turn waits in Step 2's model call.
    await expect.poll(() => fake.calls.length).toBe(2);

    const correction = await client.bot.send({
      botId,
      id: uuidv7(),
      text: "Actually, make it Thursday",
    });
    const [saved] = await readUntil(correction, () => true);
    const savedId = saved?.type === "message" ? saved.message.id : "";
    expect(saved).toMatchObject({
      type: "message",
      message: { role: "user", text: "Actually, make it Thursday" },
    });
    await fake.releaseAll();

    const rest = await readUntil(correction, () => false);
    expect(shapes(rest)).toEqual([
      { type: "message", role: "assistant", text: "Thursday it is." },
      { type: "turnEnded", status: "complete" },
    ]);
    expect((await readUntil(firstStream, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "stopped",
    });
    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["stopped", "complete"]);
    // Each Trigger records where it came from.
    expect(await triggersOf(conversationId)).toMatchObject([
      { source: "user", channel: "web", turnId: turns[0]!.id },
      { id: savedId, messageId: savedId, source: "user", channel: "web", turnId: turns[1]!.id },
    ]);
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "Book the meeting for Wednesday",
      "On it…",
      "Actually, make it Thursday",
      "Thursday it is.",
    ]);
    // The new Turn's input: the interrupted Turn's transcript, then the new Message.
    const input = inputOf(fake.calls.at(-1));
    expect(input[0]).toMatchObject({ role: "user" });
    expect(withoutNotice(input[0]?.content)).toBe("Book the meeting for Wednesday");
    expect(JSON.stringify(input.slice(1, -1))).toContain("On it…");
    expect(JSON.stringify(input)).not.toContain("Wednesday it is.");
    expect(input.at(-1)).toMatchObject({ role: "user" });
    expect(withoutNotice(input.at(-1)?.content)).toBe("Actually, make it Thursday");
  });

  it("makes one replacement Turn for several sends while the old Turn aborts", async () => {
    const { client, user, botId, fake } = await botWith([round(text("Never.")), round()], {
      manual: true,
    });
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await sendSaved(client, botId, "one");
    await expect.poll(() => fake.calls.length).toBe(1);
    await sendSaved(client, botId, "two");
    const third = await client.bot.send({ botId, id: uuidv7(), text: "three" });
    await third.next();

    await fake.releaseAll();
    expect((await readUntil(third, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["stopped", "complete"]);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      turns[0]!.id,
      turns[1]!.id,
      turns[1]!.id,
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(userTexts(fake.calls[1])).toEqual(["one", "two", "three"]);
    // The interrupted Turn keeps the input it sent, and the next Turn's history starts with it.
    expect(turns[0]!.input).toEqual(inputOf(fake.calls[0]));
    expect(inputOf(fake.calls[1]).slice(0, turns[0]!.input!.length)).toEqual(turns[0]!.input);
  });

  it("Stop after a send starts nothing: the stopped Turn takes the waiting Triggers, and the next send's Turn reads their Messages", async () => {
    const { client, user, botId, fake } = await botWith([round(text("Never.")), round()], {
      manual: true,
    });
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await sendSaved(client, botId, "one");
    await expect.poll(() => fake.calls.length).toBe(1);
    const twoId = uuidv7();
    const two = await client.bot.send({ botId, id: twoId, text: "two" });
    await two.next();

    await client.bot.stop({ botId });
    // Every chunk goes through, the next Turn's too, so this resolves only once that Turn has run.
    const released = fake.releaseAll();

    expect((await readUntil(two, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "stopped",
    });
    const [stopped, ...after] = await turnsOf(botId);
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(after).toEqual([]);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      stopped!.id,
      stopped!.id,
    ]);
    // A resend of a Message Stop left re-joins the stopped Turn.
    expect((await send(client, botId, "two", twoId)).at(-1)).toEqual({
      type: "turnEnded",
      status: "stopped",
    });
    expect(await turnsOf(botId)).toHaveLength(1);

    expect((await send(client, botId, "three")).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
    await released;
    expect(userTexts(fake.calls.at(-1))).toEqual(["one", "two", "three"]);
  });
});

describe("batching quick Messages", () => {
  /**
   * A Bot on an idle runner and a clock the test moves. `runDue()` claims a Turn's job only once
   * it is due at the clock's time, and runs it.
   */
  async function batchingBot(rounds: Round[], { manual = false, at = new Date() } = {}) {
    const timer = fakeJobClock(at);
    const { fake, jobs, client, user, botId } = await botWith(rounds, {
      idle: true,
      manual,
      clock: timer.clock.now,
      jobClock: timer.clock,
    });
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    return {
      fake,
      client,
      botId,
      conversationId,
      advance: (ms: number) => timer.advance(ms),
      now: () => timer.clock.now(),
      /** Sends `text` and reads only the saved Message. */
      sendNow: async (text: string) => {
        await sendSaved(client, botId, text);
      },
      runDue: async () => {
        const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
        if (!claimed) return false;
        await jobs.runClaimed(claimed);
        return true;
      },
    };
  }

  const userTexts = (call: TextOptions | undefined) =>
    inputOf(call)
      .filter((entry) => entry.role === "user")
      .map((entry) => withoutNotice(entry.content));

  // 13:05 UTC on 19 October 2026: London is on summer time, so its clock reads 14:05.
  const noon = new Date("2026-10-19T13:05:00.000Z");

  it("opens the Turn's newest input with the current time in the sender's zone", async () => {
    const { fake, client, botId, advance, runDue } = await batchingBot([round()], { at: noon });

    await sendSaved(client, botId, "What is on today?", { timeZone: "Europe/London" });
    advance(500);
    await runDue();

    const [message] = inputOf(fake.calls[0]).filter((entry) => entry.role === "user");
    expect(message?.content).toBe(
      "[Current time: Monday, 19 October 2026 at 14:05 (Europe/London)]\n\nWhat is on today?",
    );
  });

  it("shows the time in UTC when the send carries no zone", async () => {
    const { fake, client, botId, advance, runDue } = await batchingBot([round()], { at: noon });

    await sendSaved(client, botId, "What is on today?");
    advance(500);
    await runDue();

    const [message] = inputOf(fake.calls[0]).filter((entry) => entry.role === "user");
    expect(message?.content).toBe(
      "[Current time: Monday, 19 October 2026 at 13:05 (UTC)]\n\nWhat is on today?",
    );
  });

  it("puts the time on only the newest of the Messages a Turn took", async () => {
    const { fake, client, botId, advance, runDue } = await batchingBot([round()], { at: noon });

    await sendSaved(client, botId, "one", { timeZone: "Europe/London" });
    await sendSaved(client, botId, "two", { timeZone: "Asia/Tokyo" });
    advance(500);
    await runDue();

    const users = inputOf(fake.calls[0]).filter((entry) => entry.role === "user");
    expect(users[0]?.content).toBe("one");
    expect(users[1]?.content).toMatch(/^\[Current time: .* 22:05 \(Asia\/Tokyo\)\]\n\ntwo$/);
  });

  it("refuses a time zone that is not an IANA zone with BAD_REQUEST", async () => {
    const { client, botId, conversationId } = await batchingBot([round()]);

    await expect(
      client.bot.send({ botId, id: uuidv7(), text: "hi", timeZone: "Mars/Olympus" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await triggersOf(conversationId)).toEqual([]);
  });

  it("reads the zone of the Conversation's newest user Message", async () => {
    const { client, botId, conversationId } = await batchingBot([round()]);
    expect(await newestTimeZone(getTestDb(), conversationId)).toBeUndefined();

    await sendSaved(client, botId, "one", { timeZone: "Europe/London" });
    expect(await newestTimeZone(getTestDb(), conversationId)).toBe("Europe/London");
    await sendSaved(client, botId, "two", { timeZone: "Asia/Tokyo" });
    expect(await newestTimeZone(getTestDb(), conversationId)).toBe("Asia/Tokyo");
    await sendSaved(client, botId, "three");
    expect(await newestTimeZone(getTestDb(), conversationId)).toBeUndefined();
  });

  it("answers three sends 200 ms apart with one Turn that took all three Triggers", async () => {
    const { fake, botId, conversationId, advance, sendNow, runDue } = await batchingBot([round()]);

    await sendNow("Plan a dinner.");
    advance(200);
    await sendNow("For 4 people.");
    advance(200);
    await sendNow("Vegetarian.");

    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(1);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      turns[0]!.id,
      turns[0]!.id,
      turns[0]!.id,
    ]);
    // Its job waits 500 ms after the newest Trigger.
    advance(499);
    expect(await runDue()).toBe(false);
    advance(1);
    expect(await runDue()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(userTexts(fake.calls[0])).toEqual(["Plan a dinner.", "For 4 people.", "Vegetarian."]);
  });

  it("starts a second Turn for a send 600 ms after the last", async () => {
    const { fake, botId, conversationId, advance, sendNow, runDue } = await batchingBot([
      round(),
      round(),
    ]);

    await sendNow("one");
    advance(500);
    expect(await runDue()).toBe(true);
    advance(100);
    await sendNow("two");
    advance(500);
    expect(await runDue()).toBe(true);

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["complete", "complete"]);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      turns[0]!.id,
      turns[1]!.id,
    ]);
    expect(userTexts(fake.calls[0])).toEqual(["one"]);
    expect(userTexts(fake.calls[1])).toEqual(["one", "two"]);
  });

  it("starts a continuous burst's Turn by 2.5 s after its first Trigger", async () => {
    const { fake, botId, conversationId, advance, sendNow, runDue } = await batchingBot([
      round(text("Done.")),
    ]);

    // A send every 200 ms, from 0 to 2.4 s.
    await sendNow("0");
    for (let sent = 1; sent <= 12; sent++) {
      advance(200);
      await sendNow(String(sent));
    }

    advance(99);
    expect(await runDue()).toBe(false);
    advance(1);
    expect(await runDue()).toBe(true);
    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(1);
    expect(new Set((await triggersOf(conversationId)).map((row) => row.turnId))).toEqual(
      new Set([turns[0]!.id]),
    );
    expect(userTexts(fake.calls[0])).toHaveLength(13);
  });

  it("sets startedAt when the job starts, and the 5-minute limit counts from it", async () => {
    const { fake, botId, advance, now, sendNow, runDue } = await batchingBot([
      round(sends({ text: "On time.", endTurn: true })),
    ]);

    await sendNow("hi");
    // The job starts long after the Turn was made, past the limit from the send.
    advance(turnTimeLimitMs + 1_000);
    const start = now();
    expect(await runDue()).toBe(true);

    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", startedAt: start });
    expect(fake.calls).toHaveLength(1);
  });

  it("debounces a Turn chained by turnEnded from its newest Trigger", async () => {
    const first = round(text("First."));
    const { fake, botId, conversationId, advance, sendNow, runDue } = await batchingBot(
      [first, round(text("Second."))],
      { manual: true },
    );
    await sendNow("one");
    advance(500);
    const running = runDue();
    await expect.poll(() => fake.calls.length).toBe(1);
    advance(1_000);
    await sendNow("two");
    expect((await triggersOf(conversationId)).at(-1)?.turnId).toBeNull();
    advance(100);
    await fake.release(first.length);
    expect(await running).toBe(true);

    // "two" interrupted the running Turn, which ends once its aborted handler settles.
    await expect
      .poll(async () => (await turnsOf(botId)).map((turn) => turn.status))
      .toEqual(["stopped", "running"]);
    // Due 500 ms after "two", 400 ms from now.
    advance(399);
    expect(await runDue()).toBe(false);
    advance(1);
    const second = runDue();
    await fake.releaseAll();
    expect(await second).toBe(true);
    expect(userTexts(fake.calls[1])).toEqual(["one", "two"]);
  });

  it("never replaces a job waiting out a retry: a send interrupts its Turn, and the next Turn takes the Message", async () => {
    const { botId, conversationId, sendNow } = await batchingBot([]);
    await sendNow("one");
    const [first] = await turnsOf(botId);
    // An attempt failed before its first Checkpoint, so the job waits out its backoff with no history.
    await getTestDb().update(job).set({ attempts: 1 }).where(eq(job.id, first!.jobId!));

    await sendNow("two");

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["stopped", "running"]);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      turns[0]!.id,
      turns[1]!.id,
    ]);
    const [failed] = await getTestDb().select().from(job).where(eq(job.id, first!.jobId!));
    expect(failed).toMatchObject({ status: "cancelled", attempts: 1 });
  });
});

describe("a resent Message", () => {
  const messagesOf = (conversationId: string) =>
    getTestDb().select().from(message).where(eq(message.conversationId, conversationId));

  it("saves one Message and one Trigger, and re-joins the Turn that took it", async () => {
    const { client, user, botId, fake } = await botWith(
      [round(sends({ text: "Hello!", endTurn: true }))],
      { manual: true },
    );
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const id = uuidv7();
    expect(await sendSaved(client, botId, "hi", { id })).toMatchObject({ message: { id } });
    await expect.poll(() => fake.calls.length).toBe(1);

    const resent = await client.bot.send({ botId, id, text: "hi" });
    expect(await resent.next()).toMatchObject({ value: { message: { id, text: "hi" } } });
    await fake.releaseAll();

    const rest = await readUntil(resent, () => false);
    expect(shapes(rest)).toEqual([
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect(await messagesOf(conversationId)).toHaveLength(2);
    expect(await triggersOf(conversationId)).toMatchObject([{ id, messageId: id }]);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("streams the Turn's Messages and turnEnded when its Turn has ended", async () => {
    const { client, botId } = await botWith([round(sends({ text: "Hello!", endTurn: true }))]);
    const id = uuidv7();
    await sendSaved(client, botId, "hi", { id });
    await endedTurn(botId);

    const events = await (async () => {
      const out = [];
      for await (const event of await client.bot.send({ botId, id, text: "hi" })) out.push(event);
      return out;
    })();

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("re-joins its Turn when resent with the id in uppercase", async () => {
    const { client, user, botId } = await botWith([
      round(sends({ text: "Hello!", endTurn: true })),
    ]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const id = uuidv7();
    await send(client, botId, "hi", id);

    const events = await send(client, botId, "hi", id.toUpperCase());

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect(await triggersOf(conversationId)).toMatchObject([{ id, messageId: id }]);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it("is accepted after the Quota is spent", async () => {
    const { client, user, botId } = await hostBotWith(
      [round(sends({ text: "Hello!", endTurn: true }))],
      { getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }) },
    );
    const id = uuidv7();
    await sendSaved(client, botId, "hi", { id });
    await endedTurn(botId);
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "run",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: new Date(),
    });
    // A new Message is refused, but the resend is not.
    await expect(client.bot.send({ botId, id: uuidv7(), text: "more" })).rejects.toMatchObject({
      status: 402,
    });

    const events = await send(client, botId, "hi", id);

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
  });

  it("is refused with BAD_REQUEST when the id is used in another Conversation", async () => {
    const { client, botId } = await botWith([round(text("ok"))]);
    const other = await botWith([round(text("ok"))]);
    const id = uuidv7();
    await sendSaved(client, botId, "mine", { id });

    await expect(
      other.client.bot.send({ botId: other.botId, id, text: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    const { conversationId } = (await findBot(getTestDb(), other.user.id, other.botId))!;
    expect(await messagesOf(conversationId)).toEqual([]);
  });

  it("is rejected by validation without a uuidv7 id", async () => {
    const { client, botId } = await botWith([]);

    // @ts-expect-error the id is required
    await expect(client.bot.send({ botId, text: "hi" })).rejects.toMatchObject({ status: 400 });
    await expect(client.bot.send({ botId, id: "nope", text: "hi" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      client.bot.send({ botId, id: crypto.randomUUID(), text: "hi" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("a Turn's Quota and usage", () => {
  const oneTurn = withUsage(round(sends({ text: "Hello!", endTurn: true })), {
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
  });

  it("refuses a send out of Quota with 402, before the user's Message is saved", async () => {
    // 200 micros a day; the user has already spent 300.
    const { client, user, botId } = await hostBotWith([oneTurn], {
      getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }),
    });
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "run",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 0,
      costMicros: 300,
      estimated: false,
      createdAt: new Date(),
    });

    await expect(client.bot.send({ botId, id: uuidv7(), text: "hi" })).rejects.toMatchObject({
      status: 402,
      data: { code: "error.quotaSpent" },
    });
    expect((await client.bot.get({ botId })).messages).toEqual([]);
    expect(await turnsOf(botId)).toEqual([]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    expect(await triggersOf(conversationId)).toEqual([]);
  });

  it("records a Turn's usage as turn on Host credentials", async () => {
    const { client, user, botId } = await hostBotWith([oneTurn]);

    await send(client, botId, "hi");

    const rows = await usageOf(user.id);
    const [turn] = await turnsOf(botId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "turn",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 100 * 3 + 10 * 15,
      estimated: false,
      sourceId: turn!.id,
    });
    expect(turn?.usage).toMatchObject({ input: 100, output: 10, estimated: false });
  });

  it("records an Anthropic Turn's cache reads and writes, with input as the total, at the cache prices", async () => {
    const cachedTurn = withUsage(round(sends({ text: "Hello!", endTurn: true })), {
      // Anthropic reports input without its cache reads and writes.
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      promptTokensDetails: { cachedTokens: 80, cacheWriteTokens: 10 },
    });
    const { client, user, botId } = await hostBotWith([cachedTurn]);

    await send(client, botId, "hi");

    const [turn] = await turnsOf(botId);
    expect(await usageOf(user.id)).toMatchObject([
      {
        kind: "turn",
        inputTokens: 100,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        sourceId: turn!.id,
        costMicros: 10 * 3 + 80 * 0.3 + 10 * 6 + 10 * 15,
      },
    ]);
    expect(turn?.usage).toMatchObject({ input: 100, cached: 80, cacheWrite: 10 });
  });

  it("bills each finished model call once when the Turn fails, and a failed call nothing", async () => {
    const step = (sent: string) =>
      withUsage(round(sends({ text: sent, endTurn: false })), {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
      });
    const { client, user, botId } = await hostBotWith([
      step("One"),
      step("Two"),
      round(runError("Provider down")),
    ]);

    const events = await send(client, botId, "hi");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "error" });
    expect(await usageOf(user.id)).toMatchObject([
      { kind: "turn", inputTokens: 100, outputTokens: 10, estimated: false },
      { kind: "turn", inputTokens: 100, outputTokens: 10, estimated: false },
    ]);
    const [turn] = await turnsOf(botId);
    expect(turn?.usage).toMatchObject({ input: 200, output: 20, estimated: false });
  });

  it("records each model call at cost 0 on the user's own key, with its cache split", async () => {
    const cachedTurn = withUsage(round(sends({ text: "Hello!", endTurn: true })), {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      promptTokensDetails: { cachedTokens: 60 },
    });
    const { client, user, botId } = await botWith([cachedTurn]);

    await send(client, botId, "hi");

    const [turn] = await turnsOf(botId);
    expect(await usageOf(user.id)).toMatchObject([
      {
        kind: "turn",
        inputTokens: 100,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        costMicros: 0,
        sourceId: turn!.id,
      },
    ]);
  });
});
describe("a Turn that resumes after a crash", () => {
  // Each test claims its Turn's job by hand: no job another test left behind may be claimed first.
  beforeEach(async () => {
    await getTestDb()
      .update(job)
      .set({ status: "cancelled" })
      .where(inArray(job.status, ["queued", "running"]));
  });

  /**
   * A Bot whose Model plays `rounds` chunk by chunk as the test releases them, and whose Turn's job
   * the test runs by hand, one attempt at a time, on the fake clock. Each attempt may run on its own
   * SDK instance, as on another process.
   */
  async function crashableBot(
    rounds: Round[],
    { host = false, hooks }: { host?: boolean } & Pick<TestDepsOverrides, "hooks"> = {},
  ) {
    const fake = createFakeAdapter({ rounds, manual: true });
    const timer = fakeJobClock(new Date());
    // One pub/sub across the processes, as Redis is.
    const pubsub = countingPubSub(createMemoryPubSub());
    // Each process's runner, which runs its attempts.
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
        plugins: [bot()],
        jobs,
        adapterFor: () => fake.adapter,
        pubsub,
        hooks,
        ...(host && { hostProviders }),
      });
      runners.set(deps, jobs);
      return deps;
    };
    const deps = instance();
    const user = await insertUser();
    if (!host) {
      await saveCredentials(deps, user.id, {
        service: "openai",
        fields: { apiKey: "openai-test-key" },
        hint: "…-key",
        verified: true,
      });
    }
    const client = chatRpc({ user, deps });
    const created = await client.bot.create({ name: "Ada", model: host ? hostModel : model });
    return {
      fake,
      client,
      deps,
      user,
      botId: created.id,
      /** A process: an SDK instance that can run an attempt of the Turn's job. */
      instance,
      /**
       * Claims the Turn's job and runs one attempt of it on `on`, without waiting for it to end.
       * `drain` is the process's deploy signal: once aborted, the attempt yields at its next
       * Checkpoint.
       */
      attempt: async (on: TestDeps = deps, drain?: AbortSignal) => {
        const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: false });
        if (!claimed) throw new Error("Nothing to claim");
        return runners.get(on)!.runClaimed(claimed, { drain });
      },
      /**
       * Stops the process `on`'s runner, which waits for its attempts' handlers to end: a lost
       * attempt's handler goes on after `attempt()` resolves, to end the Turn if it still runs,
       * then acknowledge the cancel.
       */
      stopRunner: (on: TestDeps = deps) => runners.get(on)!.stop(),
      /**
       * The process running the Turn stops: its lease expires, the reaper re-queues the job (or
       * fails it after its last attempt), and the lost attempt's next heartbeat finds it gone.
       */
      crash: async () => {
        timer.advance(61_000);
        await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
        timer.tick();
      },
      /**
       * The process running the Turn dies: its lease runs out and the sweep runs, while the lost
       * attempt runs nothing more. `timer.tick()` lets it see that afterwards.
       */
      die: async () => {
        timer.advance(61_000);
        await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps);
      },
      tick: () => timer.tick(),
    };
  }

  // What a provider sends of each Message: TanStack stamps its own id and createdAt on each call's
  // assistant Message, which no adapter sends, so a replayed call has new ones.
  const modelSees = (messages: ModelMessage[]) =>
    messages.map(({ id: _id, createdAt: _at, ...sent }) => sent);

  const sentTexts = async (client: ReturnType<typeof chatRpc>, botId: string) =>
    (await client.bot.get({ botId })).messages
      .filter((row) => row.role === "assistant")
      .map((row) => row.text);

  it("killed after Step N, sends each Message once, and the next model call's input is the saved transcript", async () => {
    const third = round(sends({ text: "Three", endTurn: true }));
    const steps = [
      round(sends({ text: "One", endTurn: false })),
      round(sends({ text: "Two", endTurn: false })),
    ];
    const { fake, client, botId, attempt, crash, instance } = await crashableBot([
      ...steps,
      third,
      third,
    ]);
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "count to three" });

    const lost = attempt();
    await fake.release(steps[0]!.length + steps[1]!.length);
    // Step 2 is saved, and the attempt waits in Step 3's model call.
    await expect.poll(() => fake.calls.length).toBe(3);
    await expect.poll(() => sentTexts(client, botId)).toEqual(["One", "Two"]);
    await crash();
    await lost;

    // Another process resumes the Turn.
    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    expect(await sentTexts(client, botId)).toEqual(["One", "Two", "Three"]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", error: null });
    // Only Step 3's model call ran again, on the input the lost attempt sent.
    expect(fake.calls).toHaveLength(4);
    expect(modelSees(inputOf(fake.calls[3]))).toEqual(modelSees(inputOf(fake.calls[2])));
    const [userTurn, ...soFar] = inputOf(fake.calls[3]);
    expect(userTurn).toMatchObject({ role: "user" });
    expect(withoutNotice(userTurn?.content)).toBe("count to three");
    expect(modelSees(turn?.transcript?.slice(0, soFar.length) ?? [])).toEqual(modelSees(soFar));
    // The follow saw each Message once, though the Turn ended on another process.
    expect(shapes(await readUntil(stream, () => false))).toEqual([
      { type: "message", role: "user", text: "count to three" },
      { type: "message", role: "assistant", text: "One" },
      { type: "message", role: "assistant", text: "Two" },
      { type: "message", role: "assistant", text: "Three" },
      { type: "turnEnded", status: "complete" },
    ]);
  });

  it("killed during a model call, runs only that call again with the same input, and bills each call once", async () => {
    const usageOfStep = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const first = withUsage(round(sends({ text: "One", endTurn: false })), usageOfStep);
    const second = withUsage(round(sends({ text: "Two", endTurn: true })), usageOfStep);
    const { fake, client, user, botId, attempt, crash, instance } = await crashableBot(
      [first, second, second],
      { host: true },
    );
    await sendSaved(client, botId, "hi");

    const lost = attempt();
    // The second model call is cut off partway.
    await fake.release(first.length + 2);
    await crash();
    await lost;
    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    expect(fake.calls).toHaveLength(3);
    expect(modelSees(inputOf(fake.calls[2]))).toEqual(modelSees(inputOf(fake.calls[1])));
    expect(await sentTexts(client, botId)).toEqual(["One", "Two"]);
    // The cut-off call billed nothing; each call that finished billed once.
    expect(await usageOf(user.id)).toMatchObject([
      { kind: "turn", inputTokens: 100, outputTokens: 10, estimated: false },
      { kind: "turn", inputTokens: 100, outputTokens: 10, estimated: false },
    ]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete" });
    expect(turn?.usage).toEqual({
      input: 200,
      output: 20,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
      estimated: false,
    });
  });

  it("killed inside SendToUser's transaction, has no Message, runs the tool again and sends it once", async () => {
    const { fake, client, user, botId, attempt, crash, instance } = await crashableBot([
      round(sends({ text: "Hello!", endTurn: true })),
    ]);
    await sendSaved(client, botId, "hi");
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const lost = attempt();
    // The Turn has started, and waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(1);
    // Another connection holds the Conversation's row, so SendToUser's transaction waits on it.
    let unlock = () => {};
    let locked = () => {};
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const lock = getTestDb().transaction(async (tx) => {
      await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .for("update");
      locked();
      await new Promise<void>((resolve) => (unlock = resolve));
    });
    await holding;
    const waitingOnLocks = async () => {
      const { rows } = await getTestDb().execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return rows[0]?.n;
    };

    await fake.releaseAll();
    await expect.poll(waitingOnLocks).toBe(1);
    expect(await sentTexts(client, botId)).toEqual([]);
    await crash();
    await lost;
    const resumed = attempt(instance());
    // The resumed attempt replays the model call and runs SendToUser again.
    await expect.poll(waitingOnLocks).toBe(2);
    unlock();
    await lock;
    await resumed;

    expect(await sentTexts(client, botId)).toEqual(["Hello!"]);
    expect((await turnsOf(botId))[0]).toMatchObject({ status: "complete" });
  });

  /** How many of this database's connections wait on a lock. */
  const waitingOnLocks = async () => {
    const { rows } = await getTestDb().execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return rows[0]?.n;
  };

  /** Another connection takes the locks `take` takes, and holds them until `release()`. */
  async function holdLocks(take: (tx: Transaction) => Promise<unknown>) {
    let release = () => {};
    let held = () => {};
    const holding = new Promise<void>((resolve) => (held = resolve));
    const done = getTestDb().transaction(async (tx) => {
      await take(tx);
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  it("follows the Turn with bot.send across a resume on a second runner", async () => {
    const first = round(sends({ text: "One", endTurn: false }));
    const second = round(sends({ text: "Two", endTurn: true }));
    const { fake, client, botId, attempt, crash, instance } = await crashableBot([
      first,
      second,
      second,
    ]);
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "hi" });

    const lost = attempt();
    await fake.release(first.length);
    const before = await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    await expect.poll(() => fake.calls.length).toBe(2);
    await crash();
    await lost;
    // The follow stays open while another process resumes the Turn.
    const resumed = attempt(instance());
    const after = readUntil(stream, () => false);
    await fake.releaseAll();
    await resumed;

    expect(shapes([...before, ...(await after)])).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "One" },
      { type: "message", role: "assistant", text: "Two" },
      { type: "turnEnded", status: "complete" },
    ]);
  });

  it("ends the Turn stopped when its job is cancelled just before its last Checkpoint", async () => {
    const { fake, client, botId, attempt, instance, stopRunner } = await crashableBot([
      round(text("Nothing to add.")),
    ]);
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "ok" });
    const running = attempt();
    // The Turn has started, and waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(1);
    // Another connection holds the Turn's row, so the end_turn Checkpoint waits on it.
    const turnRow = await holdLocks((tx) =>
      tx.select({ id: botTurn.id }).from(botTurn).where(eq(botTurn.botId, botId)).for("update"),
    );

    await fake.releaseAll();
    await expect.poll(waitingOnLocks).toBe(1);
    // The end_turn Checkpoint holds the Conversation's row lock, so `bot.stop` would wait for it:
    // this is a stop whose cancel committed just before that Checkpoint began.
    const [turnBefore] = await turnsOf(botId);
    await instance().plugin("runner").cancel(turnBefore!.id);
    await turnRow.release();
    await running;
    await stopRunner();

    const turn = await endedTurn(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(JSON.stringify(turn.transcript)).toContain("Nothing to add.");
    expect((await readUntil(stream, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "stopped",
    });
  });

  /**
   * A Turn that has sent "On it…" and waits in Step 2's model call, and a send of "and then?" that
   * interrupts it. Returns that send's saved Message.
   */
  async function interruptedTurn(
    fake: ReturnType<typeof createFakeAdapter>,
    client: ReturnType<typeof chatRpc>,
    botId: string,
    attempt: () => Promise<unknown>,
  ) {
    await sendSaved(client, botId, "hi");
    const lost = attempt();
    await fake.release(round(sends({ text: "On it…", endTurn: false })).length);
    // Step 1 is saved, and the attempt waits in Step 2's model call.
    await expect.poll(() => fake.calls.length).toBe(2);
    await expect.poll(() => sentTexts(client, botId)).toEqual(["On it…"]);
    const saved = await sendSaved(client, botId, "and then?");
    return { lost, savedId: saved?.type === "message" ? saved.message.id : "" };
  }

  it("ends an interrupted Turn whose process died stopped from the sweep, and the next Turn takes the Message", async () => {
    const { fake, client, botId, attempt, die, tick, stopRunner } = await crashableBot([
      round(sends({ text: "On it…", endTurn: false })),
      round(sends({ text: "Never sent.", endTurn: true })),
    ]);
    const { lost, savedId } = await interruptedTurn(fake, client, botId, attempt);

    await die();

    const [turn, next] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(turn?.transcript)).toContain("On it…");
    expect(JSON.stringify(turn?.transcript)).not.toContain("Never sent.");
    // The Conversation recovers: the next Turn took the interrupting Message.
    expect(next).toMatchObject({ status: "running" });
    const [taken] = await getTestDb().select().from(botTrigger).where(eq(botTrigger.id, savedId));
    expect(taken?.turnId).toBe(next?.id);

    // The lost attempt finds its job gone once it runs again, and changes nothing.
    tick();
    await fake.releaseAll();
    await lost;
    await stopRunner();
    expect((await turnsOf(botId)).find(({ id }) => id === turn?.id)).toEqual(turn);
  });

  it("ends a stopped Turn whose process died stopped from the sweep, and starts nothing after it", async () => {
    const { fake, client, botId, attempt, die, tick, stopRunner } = await crashableBot([
      round(sends({ text: "On it…", endTurn: false })),
      round(sends({ text: "Never sent.", endTurn: true })),
    ]);
    const { lost, savedId } = await interruptedTurn(fake, client, botId, attempt);

    await client.bot.stop({ botId });
    await die();

    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "stopped", error: null });
    expect(JSON.stringify(turns[0]?.transcript)).toContain("On it…");
    const [taken] = await getTestDb().select().from(botTrigger).where(eq(botTrigger.id, savedId));
    expect(taken?.turnId).toBe(turns[0]?.id);

    tick();
    await fake.releaseAll();
    await lost;
    await stopRunner();
  });

  it("bot.stop on a queued Turn that already sent a Message keeps its transcript and usage", async () => {
    const usageOfStep = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const first = withUsage(round(sends({ text: "One", endTurn: false })), usageOfStep);
    const second = withUsage(round(sends({ text: "Two", endTurn: true })), usageOfStep);
    const { fake, client, user, botId, attempt } = await crashableBot([first, second], {
      host: true,
    });
    await sendSaved(client, botId, "count");

    const drain = new AbortController();
    const handedBack = attempt(undefined, drain.signal);
    await fake.release(first.length);
    await expect.poll(() => sentTexts(client, botId)).toEqual(["One"]);
    // A deploy: the attempt hands the Turn back at its next Checkpoint, queued for another process.
    drain.abort();
    await fake.releaseAll();
    await handedBack;
    const [queued] = await turnsOf(botId);
    expect(
      (await getTestDb().select().from(job).where(eq(job.id, queued!.jobId!)))[0],
    ).toMatchObject({ status: "queued" });

    await client.bot.stop({ botId });

    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(turn?.transcript?.[0]?.toolCalls?.map((call) => call.function.name)).toEqual([
      sendToUser,
    ]);
    expect(JSON.stringify(turn?.transcript)).toContain("One");
    expect(JSON.stringify(turn?.transcript)).not.toContain("Two");
    // The usage matches what was billed.
    expect(await usageOf(user.id)).toHaveLength(1);
    expect(turn?.usage).toMatchObject({ input: 100, output: 10, estimated: false });
  });

  it("never replaces the job of a Turn a deploy handed back: a send interrupts it, and the next Turn takes the Message", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { fake, client, user, botId, attempt } = await crashableBot([first, round(text("."))]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await sendSaved(client, botId, "one");
    const drain = new AbortController();
    const handedBack = attempt(undefined, drain.signal);
    await expect.poll(() => fake.calls.length).toBe(1);
    // The deploy starts: the model call's Checkpoint is saved, then the attempt yields.
    drain.abort();
    await fake.release(first.length);
    await handedBack;
    const [before] = await turnsOf(botId);
    const [queued] = await getTestDb().select().from(job).where(eq(job.id, before!.jobId!));
    expect(queued).toMatchObject({ status: "queued" });

    await sendSaved(client, botId, "two");

    // Its queued job never runs again: the Turn ends stopped at once, and the next one starts.
    const [after, next] = await turnsOf(botId);
    expect(after).toMatchObject({ status: "stopped", jobId: before!.jobId });
    const [cancelled] = await getTestDb().select().from(job).where(eq(job.id, before!.jobId!));
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(next).toMatchObject({ status: "running" });
    expect((await triggersOf(conversationId)).at(-1)?.turnId).toBe(next?.id);
  });

  it("fires onUsage for a bill whose Checkpoint a deploy's yield follows", async () => {
    const onUsage = vi.fn();
    const usageOfStep = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const { fake, client, user, botId, attempt, instance } = await crashableBot(
      [withUsage(round(sends({ text: "Hello!", endTurn: true })), usageOfStep)],
      { host: true, hooks: createHookEmitter({ onUsage }, silent) },
    );
    await sendSaved(client, botId, "hi");
    // Another connection holds the usage table, so the bill's transaction waits on it.
    const usageTable = await holdLocks((tx) =>
      tx.execute(sql`lock table chat.usage in share mode`),
    );

    const drain = new AbortController();
    const handedBack = attempt(undefined, drain.signal);
    await fake.releaseAll();
    await expect.poll(waitingOnLocks).toBe(1);
    // The deploy starts while the bill is being saved: it commits, then the attempt yields.
    drain.abort();
    await usageTable.release();
    await handedBack;
    // Another process resumes the Turn and replays the bill.
    await attempt(instance());

    expect((await turnsOf(botId))[0]).toMatchObject({ status: "complete" });
    const rows = await usageOf(user.id);
    expect(rows).toHaveLength(1);
    await expect.poll(() => onUsage.mock.calls.length).toBe(1);
    expect(onUsage).toHaveBeenCalledWith(rows[0]);
  });

  it("ends a Turn resumed past 5 minutes timed_out without sending its recorded Step's Message", async () => {
    const { fake, client, user, botId, attempt, crash, instance } = await crashableBot([
      round(sends({ text: "Here's the answer.", endTurn: true })),
    ]);
    await sendSaved(client, botId, "a question");
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const lost = attempt();
    // The Turn has started, and waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(1);
    // Another connection holds the Conversation's row, so SendToUser's transaction waits on it.
    const conversationRow = await holdLocks((tx) =>
      tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .for("update"),
    );

    await fake.releaseAll();
    await expect.poll(waitingOnLocks).toBe(1);
    // The model call is recorded; the process stops before SendToUser's Checkpoint.
    await crash();
    await lost;
    // The outage lasted past the limit.
    await ageTurn(botId, turnTimeLimitMs + 1_000);
    const resumed = attempt(instance());
    await conversationRow.release();
    await resumed;

    expect(fake.calls).toHaveLength(1);
    expect(await sentTexts(client, botId)).toEqual([]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "timed_out" });
    expect(JSON.stringify(turn?.transcript)).not.toContain("Here's the answer.");
  });

  it("ends the Turn error / interrupted after three lost attempts, with the transcript of what it did", async () => {
    const first = round(text("Private note."), sends({ text: "One", endTurn: false }));
    const hangs = round(sends({ text: "Never sent.", endTurn: true }));
    const { fake, client, botId, attempt, crash } = await crashableBot([
      first,
      hangs,
      hangs,
      hangs,
    ]);
    await sendSaved(client, botId, "hi");

    const lost = [attempt()];
    await fake.release(first.length);
    for (const calls of [2, 3, 4]) {
      // Each attempt waits in the second Step's model call when its process stops.
      await expect.poll(() => fake.calls.length).toBe(calls);
      await crash();
      if (calls < 4) lost.push(attempt());
    }
    await Promise.all(lost);

    expect(await sentTexts(client, botId)).toEqual(["One"]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "interrupted" });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    // The first Step, written by onFailed from the recorded calls: the cut-off ones aren't in it.
    expect(turn?.transcript?.map((entry) => entry.role)).toEqual(["assistant", "tool"]);
    expect(turn?.transcript?.[0]?.content).toBe("Private note.");
    expect(JSON.stringify(turn?.transcript)).toContain("One");
    expect(JSON.stringify(turn?.transcript)).not.toContain("Never sent.");
  });

  it("starts the next Turn for a Message queued while a Turn was lost, once onFailed ends it", async () => {
    const hangs = round(text("Never."));
    const { fake, client, deps, user, botId, attempt, crash } = await crashableBot([
      hangs,
      hangs,
      hangs,
    ]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await sendSaved(client, botId, "one");

    const lost = [attempt()];
    await expect.poll(() => fake.calls.length).toBe(1);
    await queueTrigger(deps, conversationId, "two");
    for (const calls of [1, 2, 3]) {
      await expect.poll(() => fake.calls.length).toBe(calls);
      await crash();
      if (calls < 3) lost.push(attempt());
    }
    await Promise.all(lost);

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["error", "running"]);
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      turns[0]!.id,
      turns[1]!.id,
    ]);
    const [next] = await getTestDb().select().from(job).where(eq(job.id, turns[1]!.jobId!));
    expect(next).toMatchObject({ name: "bot.turn", status: "queued" });
  });

  /** Moves the Turn's start and its Conversation's Messages `ms` into the past. */
  async function ageTurn(botId: string, ms: number) {
    const ago = (column: typeof botTurn.startedAt | typeof message.createdAt) =>
      sql`${column} - ${ms} * interval '1 millisecond'`;
    await getTestDb()
      .update(message)
      .set({ createdAt: ago(message.createdAt) });
    await getTestDb()
      .update(botTurn)
      .set({ startedAt: ago(botTurn.startedAt) })
      .where(eq(botTurn.botId, botId));
  }

  it("rebuilds the reminder after a plain-text Step on replay, from the recorded model call", async () => {
    const first = round(text("I can't send email."));
    const reply = round(sends({ text: "I can't send email.", endTurn: true }));
    const { fake, client, botId, attempt, crash, instance } = await crashableBot([
      first,
      reply,
      reply,
    ]);
    await sendSaved(client, botId, "Send this summary to my boss");

    const lost = attempt();
    await fake.release(first.length);
    // The plain-text Step is saved, and the attempt waits in the reminder Step's model call.
    await expect.poll(() => fake.calls.length).toBe(2);
    await crash();
    await lost;
    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    // Only the reminder Step's call ran again, on the same input: the reminder was rebuilt.
    expect(fake.calls).toHaveLength(3);
    expect(modelSees(inputOf(fake.calls[2]))).toEqual(modelSees(inputOf(fake.calls[1])));
    expect(String(inputOf(fake.calls[2]).at(-1)?.content)).toMatch(/not delivered/i);
    expect(await sentTexts(client, botId)).toEqual(["I can't send email."]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", error: null });
    expect(turn?.transcript?.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("counts the Steps of earlier attempts toward the 10-Step limit", async () => {
    const step = round(sends({ text: "More", endTurn: false }));
    const { fake, client, botId, attempt, crash, instance } = await crashableBot(
      Array.from({ length: 12 }, () => step),
    );
    await sendSaved(client, botId, "go on forever");

    const lost = attempt();
    await fake.release(step.length * 6);
    // Six Steps are saved, and the attempt waits in the seventh's model call.
    await expect.poll(() => fake.calls.length).toBe(7);
    await expect.poll(async () => (await sentTexts(client, botId)).length).toBe(6);
    await crash();
    await lost;
    const resumed = attempt(instance());
    await fake.releaseAll();
    await resumed;

    expect(await sentTexts(client, botId)).toHaveLength(10);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "error", error: "step_limit" });
  });

  it("ends a resumed Turn past 5 minutes timed_out without calling the Model", async () => {
    const step = round(sends({ text: "One", endTurn: false }));
    const { fake, client, botId, attempt, crash, instance } = await crashableBot([step, step]);
    await sendSaved(client, botId, "hi");

    const lost = attempt();
    await fake.release(step.length);
    await expect.poll(() => fake.calls.length).toBe(2);
    await expect.poll(() => sentTexts(client, botId)).toEqual(["One"]);
    await crash();
    await lost;
    // The crash lasted past the limit.
    await ageTurn(botId, turnTimeLimitMs + 1_000);
    await attempt(instance());

    // The recorded Step replays without calling the Model or sending its Message again.
    expect(fake.calls).toHaveLength(2);
    expect(await sentTexts(client, botId)).toEqual(["One"]);
    expect((await turnsOf(botId))[0]).toMatchObject({ status: "error", error: "timed_out" });
  });
});

describe("the bot plugin on a runner that is not in-process", () => {
  it("fails at startup, because a retry there starts over and would send Messages again", () => {
    const elsewhere: JobRunner = {
      enqueue: async () => "job",
      cancel: async () => {},
      status: async () => undefined,
      schedule: async () => {},
      start: async () => {},
      stop: async () => {},
    };

    expect(() => createTestSdk({ plugins: [bot()], jobs: elsewhere })).toThrow(/in-process/);
  });
});
