import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTurn, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { bot } from "../../../../plugins/bot/server/plugin";
import { turnTimeLimitMs } from "../../../../plugins/bot/server/store";
import { sendToBot } from "../../../../plugins/bot/server/turn";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { quotaLookup } from "../../../../plugins/models/server/quota";
import { createTestSdk, type TestDepsOverrides } from "../../../support/deps";
import {
  createFakeAdapter,
  round,
  runError,
  text,
  toolCall,
  withUsage,
} from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const model = "openai:gpt-5.6";
const sendToUser = "send_to_user";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** A user with an OpenAI key, a Bot on `model`, and a client over a Bot-enabled SDK whose Model plays `rounds`. */
async function botWith(
  rounds: Round[],
  { manual = false, clock }: { manual?: boolean } & Pick<TestDepsOverrides, "clock"> = {},
) {
  const fake = createFakeAdapter({ rounds, manual });
  const deps = createTestSdk({ plugins: [bot()], adapterFor: () => fake.adapter, clock });
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
  const deps = createTestSdk({
    plugins: [bot()],
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

/** A Turn row of `botId`, as a process left it. */
async function insertTurn(
  botId: string,
  fields: { status: "running"; startedAt: Date; heartbeatAt: Date | null },
) {
  const id = uuidv7();
  await getTestDb()
    .insert(botTurn)
    .values({ id, botId, ...fields });
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
async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  const events = [];
  for await (const event of await client.bot.send({ botId, text })) events.push(event);
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
  return getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
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

    await expect(other.bot.send({ botId, text: "hi" })).rejects.toMatchObject({
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

    const stream = await client.bot.send({ botId, text: "take your time" });
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

  it("ends the Turn stopped when the client aborts, with its transcript saved", async () => {
    const first = round(sends({ text: "On it…", endTurn: false }));
    const { client, botId, fake } = await botWith([first, round(text("Never comes."))], {
      manual: true,
    });
    const abort = new AbortController();

    const stream = await client.bot.send({ botId, text: "hi" }, { signal: abort.signal });
    await fake.release(first.length);
    await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    abort.abort();
    await stream.return?.(undefined).catch(() => {});

    const turn = await endedTurn(botId);
    expect(turn).toMatchObject({ status: "stopped", error: null });
    // The Step that finished is in the transcript, so the next Turn sees what was sent.
    expect(JSON.stringify(turn.transcript)).toContain("On it…");
    expect((await client.bot.get({ botId })).messages.map((row) => row.text)).toEqual([
      "hi",
      "On it…",
    ]);
  });

  it("ends the Turn stopped when its stream is left before it is read, so the next send isn't refused", async () => {
    const { deps, user, client, botId } = await botWith([
      round(sends({ text: "Back.", endTurn: true })),
    ]);

    // The transport may drop a stream it never pulled from: `return()` before any `next()`.
    const stream = await sendToBot(deps, { userId: user.id, botId, text: "hi" });
    await stream.return(undefined);

    expect(await endedTurn(botId)).toMatchObject({ status: "stopped", error: null });
    expect((await send(client, botId, "again")).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
  });
});

/** A `running` Turn of a live process: it started 2 minutes ago and its heartbeat is 30 s old. */
const live = () => ({
  status: "running" as const,
  startedAt: new Date(Date.now() - 2 * 60_000),
  heartbeatAt: new Date(Date.now() - 30_000),
});

/**
 * `running` Turns a dead process left: started only 2 minutes ago, well inside the time limit, but
 * with a heartbeat over 60 s old, or none.
 */
const dead = [
  {
    heartbeat: "a heartbeat over 60 s old",
    fields: () => ({
      status: "running" as const,
      startedAt: new Date(Date.now() - 2 * 60_000),
      heartbeatAt: new Date(Date.now() - 61_000),
    }),
  },
  {
    heartbeat: "no heartbeat",
    fields: () => ({
      status: "running" as const,
      startedAt: new Date(Date.now() - 2 * 60_000),
      heartbeatAt: null,
    }),
  },
];

describe("one Turn at a time", () => {
  it("refuses a Message while a Turn with a fresh heartbeat is running with 409, and saves nothing", async () => {
    const { client, botId } = await botWith([]);
    await insertTurn(botId, live());

    await expect(client.bot.send({ botId, text: "hello?" })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      data: { code: "error.turnRunning" },
    });
    expect((await client.bot.get({ botId })).messages).toEqual([]);
    expect(await turnsOf(botId)).toHaveLength(1);
  });

  it.each(dead)(
    "marks a running Turn with $heartbeat error / interrupted when the next Turn starts",
    async ({ fields }) => {
      const { client, botId } = await botWith([round(sends({ text: "Back.", endTurn: true }))]);
      const stale = await insertTurn(botId, fields());

      const events = await send(client, botId, "still there?");

      expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
      const turns = await turnsOf(botId);
      expect(turns.find((turn) => turn.id === stale)).toMatchObject({
        status: "error",
        error: "interrupted",
      });
      expect(turns.find((turn) => turn.id === stale)?.endedAt).toBeInstanceOf(Date);
    },
  );

  it.each(dead)(
    "reads a running Turn with $heartbeat as error in bot.get and bot.list",
    async ({ fields }) => {
      const { client, botId } = await botWith([]);
      await insertTurn(botId, fields());

      expect((await client.bot.get({ botId })).bot.turnStatus).toBe("error");
      expect((await client.bot.list()).find((listed) => listed.id === botId)?.turnStatus).toBe(
        "error",
      );
    },
  );

  it("reads a running Turn with a fresh heartbeat as running", async () => {
    const { client, botId } = await botWith([]);
    await insertTurn(botId, live());

    expect((await client.bot.get({ botId })).bot.turnStatus).toBe("running");
    expect((await client.bot.list()).find((listed) => listed.id === botId)?.turnStatus).toBe(
      "running",
    );
  });
});

describe("a Turn's heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The Turn's `heartbeat_at` once it is `at`; a write the clock started lands a moment later. */
  async function heartbeatBecomes(botId: string, at: Date) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [turn] = await turnsOf(botId);
      if (turn?.heartbeatAt?.getTime() === at.getTime()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`The heartbeat never reached ${at.toISOString()}`);
  }

  it("writes heartbeat_at when the Turn starts and every 10 s while it runs, and stops when it ends", async () => {
    let now = Date.now();
    const first = round(sends({ text: "On it…", endTurn: false }));
    const last = round(sends({ text: "Done.", endTurn: true }));
    const { client, botId, fake } = await botWith([first, last], {
      manual: true,
      clock: () => new Date(now),
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const stream = await client.bot.send({ botId, text: "hi" });
    const startedAt = new Date(now);
    expect((await turnsOf(botId))[0]?.heartbeatAt).toEqual(startedAt);

    await fake.release(first.length);
    await readUntil(
      stream,
      (event) => event.type === "message" && event.message.role === "assistant",
    );
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await heartbeatBecomes(botId, new Date(now));
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await heartbeatBecomes(botId, new Date(now));
    const lastBeat = new Date(now);

    await fake.release(last.length);
    expect((await readUntil(stream, () => false)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });
    now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete", heartbeatAt: lastBeat });
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

    await expect(client.bot.send({ botId, text: "hi" })).rejects.toMatchObject({
      status: 402,
      data: { code: "error.quotaSpent" },
    });
    expect((await client.bot.get({ botId })).messages).toEqual([]);
    expect(await turnsOf(botId)).toEqual([]);
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

  it("records each finished Step's reported usage when the Turn fails", async () => {
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
      { kind: "turn", inputTokens: 200, outputTokens: 20, estimated: false },
    ]);
  });

  it("records nothing on the user's own key", async () => {
    const { client, user, botId } = await botWith([oneTurn]);

    await send(client, botId, "hi");

    expect(await usageOf(user.id)).toEqual([]);
  });
});
