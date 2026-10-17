import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHookEmitter } from "../../../../core/server/chat/hooks";
import { createMemoryPubSub } from "../../../../core/server/chat/pubsub";
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
import { bot } from "../../../../plugins/bot/server/plugin";
import { turnTimeLimitMs } from "../../../../plugins/bot/server/store";
import { findBot } from "../../../../plugins/bot/server/store";
import { sendToBot } from "../../../../plugins/bot/server/turn";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { quotaLookup } from "../../../../plugins/models/server/quota";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import type { JobRunner } from "../../../../plugins/runner/server/jobs/runner";
import {
  claimJob,
  reapStaleJobs,
  runClaimedJob,
} from "../../../../plugins/runner/server/jobs/store";
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

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/**
 * A Bot-enabled SDK over `overrides`, whose in-process runner runs the Turns' jobs. It is started
 * and stopped after the test; it drains for only 50 ms, so a Turn a test leaves hanging is aborted.
 */
async function sdkWithRunner(overrides: TestDepsOverrides, { idle = false } = {}) {
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({ plugins: [bot()], jobs, ...overrides });
  // An idle runner never claims a job, so a Turn stays queued.
  if (!idle) await jobs.start();
  started.push(jobs);
  return deps;
}

/** A user with an OpenAI key, a Bot on `model`, and a client over a Bot-enabled SDK whose Model plays `rounds`. */
async function botWith(
  rounds: Round[],
  {
    manual = false,
    pubsub,
    clock,
    idle = false,
  }: { manual?: boolean; idle?: boolean } & Pick<TestDepsOverrides, "pubsub" | "clock"> = {},
) {
  const fake = createFakeAdapter({ rounds, manual });
  const deps = await sdkWithRunner({ adapterFor: () => fake.adapter, pubsub, clock }, { idle });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, user, botId: created.id };
}

const hostModel = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens and $15 per 1M output tokens, so a token costs as many micros as its price.
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

/** A user with no key of their own, and a Bot on the Host's Model. */
async function hostBotWith(rounds: Round[], overrides: Pick<TestDepsOverrides, "getQuota"> = {}) {
  const fake = createFakeAdapter({ rounds });
  const deps = await sdkWithRunner({ hostProviders, adapterFor: () => fake.adapter, ...overrides });
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

/** The model input of one call: its messages, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

describe("bot.send", () => {
  it("keeps a reply with no tool call private: zero Messages, a complete Turn, its text in the transcript", async () => {
    const { client, botId } = await botWith([round(text("Nothing to add here."))]);

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
      round(text("I'll stay quiet.")),
    ]);

    const events = await send(client, botId, "hm");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hm" },
      { type: "turnEnded", status: "complete" },
    ]);
    // The Model read the error and got its next Step.
    const result = inputOf(fake.calls[1]).find((message) => message.role === "tool");
    expect(String(result?.content)).toMatch(/text.*empty|empty.*text/i);
    expect(String(result?.content)).toMatch(/reply without calling a tool/i);
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
    expect(input[0]).toMatchObject({ role: "user", content: "hi" });
    // The Model sees its send as a SendToUser call, never as plain assistant text.
    expect(input[1]?.toolCalls?.map((call) => call.function.name)).toEqual([sendToUser]);
    expect(JSON.parse(input[1]?.toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
      text: "Hello!",
      endTurn: true,
    });
    expect(input[1]?.content).toBe("Private note.");
    expect(input[3]).toMatchObject({ role: "user", content: "thanks" });
  });

  it("gives another user not-found for a Bot that isn't theirs", async () => {
    const { botId, deps } = await botWith([]);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.send({ botId, id: uuidv7(), text: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
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
    const [row] = await getTestDb().select().from(job).where(eq(job.id, turn!.jobId!));
    expect(row).toMatchObject({
      name: "bot.turn",
      payload: { turnId: turn!.id },
      status: "succeeded",
    });
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
    const stream = await client.bot.send({ botId, id: uuidv7(), text: "hi" });
    await stream.next();

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
});

describe("one Turn at a time", () => {
  it("queues a Message sent while a Turn runs, and the next Turn takes it when the first ends", async () => {
    const { client, user, botId, fake } = await botWith(
      [
        round(sends({ text: "Done.", endTurn: true })),
        round(sends({ text: "Got the second.", endTurn: true })),
      ],
      { manual: true },
    );
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const firstStream = await client.bot.send({ botId, id: uuidv7(), text: "one" });
    const [first] = await readUntil(firstStream, () => true);
    // The first Turn waits in its model call.
    await expect.poll(() => fake.calls.length).toBe(1);

    const secondStream = await client.bot.send({ botId, id: uuidv7(), text: "two" });
    const [second] = await readUntil(secondStream, () => true);

    // No CONFLICT: the Message is saved, and its Trigger waits for the next Turn.
    expect(second).toMatchObject({ type: "message", message: { role: "user", text: "two" } });
    const [firstTurn] = await turnsOf(botId);
    const firstId = first?.type === "message" ? first.message.id : "";
    const secondId = second?.type === "message" ? second.message.id : "";
    expect(await triggersOf(conversationId)).toMatchObject([
      { id: firstId, messageId: firstId, source: "user", channel: "web", turnId: firstTurn!.id },
      { id: secondId, messageId: secondId, source: "user", channel: "web", turnId: null },
    ]);
    expect(await turnsOf(botId)).toHaveLength(1);

    await fake.releaseAll();

    // The queued send's stream follows the Turn that took it through to its end.
    const rest = await readUntil(secondStream, () => false);
    expect(shapes(rest).at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(shapes(rest)).toContainEqual({
      type: "message",
      role: "assistant",
      text: "Got the second.",
    });
    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["complete", "complete"]);
    const secondTurn = turns.find((turn) => turn.id !== firstTurn!.id)!;
    expect((await triggersOf(conversationId)).map((row) => row.turnId)).toEqual([
      firstTurn!.id,
      secondTurn.id,
    ]);
    // The second Turn's input holds the first exchange, then the queued Message.
    const input = inputOf(fake.calls[1]);
    expect(input[0]).toMatchObject({ role: "user", content: "one" });
    expect(input.at(-1)).toMatchObject({ role: "user", content: "two" });
    expect(JSON.stringify(input)).toContain("Done.");
  });

  it("has the next Turn take every waiting Trigger, in the order they were received", async () => {
    const { client, user, botId, fake } = await botWith(
      [round(text("First.")), round(text("Both."))],
      { manual: true },
    );
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await (await client.bot.send({ botId, id: uuidv7(), text: "one" })).next();
    await expect.poll(() => fake.calls.length).toBe(1);
    await (await client.bot.send({ botId, id: uuidv7(), text: "two" })).next();
    const third = await client.bot.send({ botId, id: uuidv7(), text: "three" });
    await third.next();

    await fake.releaseAll();
    expect((await readUntil(third, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });

    const turns = await turnsOf(botId);
    expect(turns).toHaveLength(2);
    const taken = await triggersOf(conversationId);
    expect(taken.map((row) => row.turnId)).toEqual([turns[0]!.id, turns[1]!.id, turns[1]!.id]);
    expect(fake.calls).toHaveLength(2);
    const users = inputOf(fake.calls[1]).filter((entry) => entry.role === "user");
    expect(users.map((entry) => entry.content)).toEqual(["one", "two", "three"]);
  });

  it("starts the next Turn when the running one ends error", async () => {
    const { client, botId, fake } = await botWith(
      [round(runError("Provider down")), round(text("Back."))],
      { manual: true },
    );
    await (await client.bot.send({ botId, id: uuidv7(), text: "one" })).next();
    await expect.poll(() => fake.calls.length).toBe(1);
    const queued = await client.bot.send({ botId, id: uuidv7(), text: "two" });
    await queued.next();

    await fake.releaseAll();

    expect((await readUntil(queued, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
    expect((await turnsOf(botId)).map((turn) => turn.status).sort()).toEqual(["complete", "error"]);
  });

  it("starts the next Turn when the running one is stopped", async () => {
    const { client, botId, fake } = await botWith([round(text("Never.")), round(text("Back."))], {
      manual: true,
    });
    await (await client.bot.send({ botId, id: uuidv7(), text: "one" })).next();
    await expect.poll(() => fake.calls.length).toBe(1);
    const queued = await client.bot.send({ botId, id: uuidv7(), text: "two" });
    await queued.next();

    await client.bot.stop({ botId });
    await fake.releaseAll();

    expect((await readUntil(queued, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
    expect((await turnsOf(botId)).map((turn) => turn.status).sort()).toEqual([
      "complete",
      "stopped",
    ]);
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

describe("batching quick Messages", () => {
  /**
   * A Bot on an idle runner and a clock the test moves. `runDue()` claims a Turn's job only once
   * it is due at the clock's time, and runs it.
   */
  async function batchingBot(rounds: Round[], { manual = false } = {}) {
    const timer = fakeJobClock(new Date());
    const { fake, deps, client, user, botId } = await botWith(rounds, {
      idle: true,
      manual,
      clock: timer.clock.now,
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
        await (await client.bot.send({ botId, id: uuidv7(), text })).next();
      },
      runDue: async () => {
        const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
        if (!claimed) return false;
        await runClaimedJob(getTestDb(), claimed, {
          clock: timer.clock,
          logger: silent,
          deps: () => deps,
        });
        return true;
      },
    };
  }

  const userTexts = (call: TextOptions | undefined) =>
    inputOf(call)
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content);

  it("answers three sends 200 ms apart with one Turn that took all three Triggers", async () => {
    const { fake, botId, conversationId, advance, sendNow, runDue } = await batchingBot([
      round(text("All three.")),
    ]);

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
      round(text("First.")),
      round(text("Second.")),
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

    const turns = await turnsOf(botId);
    expect(turns.map((turn) => turn.status)).toEqual(["complete", "running"]);
    // Due 500 ms after "two", 400 ms from now.
    advance(399);
    expect(await runDue()).toBe(false);
    advance(1);
    const second = runDue();
    await fake.releaseAll();
    expect(await second).toBe(true);
    expect(userTexts(fake.calls[1])).toEqual(["one", "two"]);
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
    const first = await client.bot.send({ botId, id, text: "hi" });
    expect(await first.next()).toMatchObject({ value: { message: { id } } });
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
    await client.bot.send({ botId, id, text: "hi" });
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

  it("is accepted after the Quota is spent", async () => {
    const { client, user, botId } = await hostBotWith(
      [round(sends({ text: "Hello!", endTurn: true }))],
      { getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }) },
    );
    const id = uuidv7();
    await client.bot.send({ botId, id, text: "hi" });
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
    await client.bot.send({ botId, id, text: "mine" });

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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "turn",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 100 * 3 + 10 * 15,
      estimated: false,
    });
    const [turn] = await turnsOf(botId);
    expect(turn?.usage).toMatchObject({ input: 100, output: 10, estimated: false });
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

  it("records nothing on the user's own key", async () => {
    const { client, user, botId } = await botWith([oneTurn]);

    await send(client, botId, "hi");

    expect(await usageOf(user.id)).toEqual([]);
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
    const pubsub = createMemoryPubSub();
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
        plugins: [bot()],
        jobs,
        adapterFor: () => fake.adapter,
        pubsub,
        hooks,
        ...(host && { hostProviders }),
      });
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
        return runClaimedJob(getTestDb(), claimed, {
          clock: timer.clock,
          logger: silent,
          deps: () => on,
          drain,
        });
      },
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
    expect(userTurn).toMatchObject({ role: "user", content: "count to three" });
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
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });

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
      estimated: false,
    });
  });

  it("killed inside SendToUser's transaction, has no Message, runs the tool again and sends it once", async () => {
    const { fake, client, user, botId, attempt, crash, instance } = await crashableBot([
      round(sends({ text: "Hello!", endTurn: true })),
    ]);
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });
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
    const { fake, client, botId, attempt, instance } = await crashableBot([
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

    const turn = await endedTurn(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(JSON.stringify(turn.transcript)).toContain("Nothing to add.");
    expect((await readUntil(stream, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "stopped",
    });
  });

  it("ends a stopped Turn whose process died stopped from the sweep, with the transcript of what it did", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { fake, client, botId, attempt, die, tick } = await crashableBot([
      first,
      round(sends({ text: "Never sent.", endTurn: true })),
    ]);
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });
    const lost = attempt();
    await fake.release(first.length);
    // Step 1 is saved, and the attempt waits in Step 2's model call.
    await expect.poll(() => fake.calls.length).toBe(2);
    await expect.poll(() => sentTexts(client, botId)).toEqual(["On it…"]);
    // A Message queued behind the Turn.
    const queued = await client.bot.send({ botId, id: uuidv7(), text: "and then?" });
    const [saved] = await readUntil(queued, () => true);

    await client.bot.stop({ botId });
    await die();

    const [turn, next] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(turn?.transcript)).toContain("On it…");
    expect(JSON.stringify(turn?.transcript)).not.toContain("Never sent.");
    // The Conversation recovers: the next Turn took the queued Message.
    expect(next).toMatchObject({ status: "running" });
    const [taken] = await getTestDb()
      .select()
      .from(botTrigger)
      .where(eq(botTrigger.id, saved?.type === "message" ? saved.message.id : ""));
    expect(taken?.turnId).toBe(next?.id);

    // The lost attempt finds its job gone once it runs again, and changes nothing.
    tick();
    await fake.releaseAll();
    await lost;
    expect((await turnsOf(botId)).find(({ id }) => id === turn?.id)).toEqual(turn);
  });

  it("bot.stop on a queued Turn that already sent a Message keeps its transcript and usage", async () => {
    const usageOfStep = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const first = withUsage(round(sends({ text: "One", endTurn: false })), usageOfStep);
    const second = withUsage(round(sends({ text: "Two", endTurn: true })), usageOfStep);
    const { fake, client, user, botId, attempt } = await crashableBot([first, second], {
      host: true,
    });
    await client.bot.send({ botId, id: uuidv7(), text: "count" });

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

  it("never replaces the job of a Turn a deploy handed back: a send waits for the next Turn", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { fake, client, user, botId, attempt } = await crashableBot([first, round(text("."))]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await client.bot.send({ botId, id: uuidv7(), text: "one" });
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

    await (await client.bot.send({ botId, id: uuidv7(), text: "two" })).next();

    const [after] = await turnsOf(botId);
    expect(after?.jobId).toBe(before!.jobId);
    expect((await triggersOf(conversationId)).at(-1)?.turnId).toBeNull();
  });

  it("fires onUsage for a bill whose Checkpoint a deploy's yield follows", async () => {
    const onUsage = vi.fn();
    const usageOfStep = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const { fake, client, user, botId, attempt, instance } = await crashableBot(
      [withUsage(round(sends({ text: "Hello!", endTurn: true })), usageOfStep)],
      { host: true, hooks: createHookEmitter({ onUsage }, silent) },
    );
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });
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
    await client.bot.send({ botId, id: uuidv7(), text: "a question" });
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
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });

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
    const { fake, client, user, botId, attempt, crash } = await crashableBot([hangs, hangs, hangs]);
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    await client.bot.send({ botId, id: uuidv7(), text: "one" });

    const lost = [attempt()];
    await expect.poll(() => fake.calls.length).toBe(1);
    await (await client.bot.send({ botId, id: uuidv7(), text: "two" })).next();
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

  it("counts the Steps of earlier attempts toward the 10-Step limit", async () => {
    const step = round(sends({ text: "More", endTurn: false }));
    const { fake, client, botId, attempt, crash, instance } = await crashableBot(
      Array.from({ length: 12 }, () => step),
    );
    await client.bot.send({ botId, id: uuidv7(), text: "go on forever" });

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
    await client.bot.send({ botId, id: uuidv7(), text: "hi" });

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
