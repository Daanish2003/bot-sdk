import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { recordChange, retainedChanges } from "../../../../core/server/chat/change-log";
import {
  botCheckIn,
  botHelper,
  botReview,
  botRoutine,
  botTurn,
  conversationChange,
} from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { findBot } from "../../../../plugins/bot/server/store";
import type { BotChange } from "../../../../plugins/bot/shared/changes";
import { computer } from "../../../../plugins/computer/server/plugin";
import {
  deleteCredentials,
  saveCredentials,
} from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };
const timeout = 30_000;
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

/**
 * A user with an OpenAI key and a Bot with its Computer, on a running in-process runner: its Turns
 * play `turns` and its Helpers play `helpers`.
 */
async function botWith(turns: Round[] = [], helpers: Round[] = []) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      isHelperCall(options)
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as AnyTextAdapter;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: fakeComputerProvider().provider })],
    jobs,
    adapterFor: () => adapter,
    memory: false,
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
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  return { deps, client, user, botId, conversationId };
}

type Client = ReturnType<typeof chatRpc>;

/** Sends `message` and follows its Turn to its end. */
async function send(client: Client, botId: string, message: string, id = uuidv7()) {
  for await (const event of await client.bot.send({ botId, id, text: message })) void event;
}

/** The changes after `since`, which must not need a reload. */
async function changesAfter(client: Client, botId: string, since: number): Promise<BotChange[]> {
  const result = await client.bot.changes({ botId, since });
  if (result.reload) throw new Error(`bot.changes since ${since} asked for a reload`);
  return result.changes;
}

/** The newest seq of the Bot's change log, once nothing is running. */
async function cursorOf(client: Client, botId: string): Promise<number> {
  return (await changesAfter(client, botId, 0)).at(-1)?.seq ?? 0;
}

const kindsOf = (changes: BotChange[]) => changes.map((change) => change.kind);

const sends = (message: string, endTurn = true) =>
  toolCall({ name: "send_to_user", input: { text: message, endTurn } });

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

/** Waits until none of the Bot's Turns and Helpers runs. */
async function settled(botId: string) {
  await expect
    .poll(async () => {
      const helpers = await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId));
      const turns = await turnsOf(botId);
      return [...helpers, ...turns].every((row) => row.status !== "running");
    }, poll)
    .toBe(true);
}

describe("bot.changes", () => {
  it(
    "returns a sent Message, its Turn's status and start, the Bot's Message and the Turn's end in seq order",
    async () => {
      const { client, botId } = await botWith([round(sends("Hello!"))]);

      const id = uuidv7();
      await send(client, botId, "Hi", id);

      const changes = await changesAfter(client, botId, 0);
      expect(changes.map((change) => change.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(kindsOf(changes)).toEqual(["message", "turn", "turn", "message", "turn"]);
      const [user, running, started, reply, ended] = changes;
      expect(user).toMatchObject({ refId: id, data: { id, role: "user", text: "Hi" } });
      // A Turn's changes all point at the same Turn, as it is now.
      expect(running!.refId).toBe(ended!.refId);
      expect(started!.refId).toBe(ended!.refId);
      expect(ended!.data).toMatchObject({ status: "complete" });
      expect(reply!.data).toMatchObject({ role: "assistant", text: "Hello!" });
      expect(await changesAfter(client, botId, 2)).toEqual(changes.slice(2));
      expect(await changesAfter(client, botId, 5)).toEqual([]);
      // `get` gives the cursor to follow the thread from.
      expect((await client.bot.get({ botId })).lastSeq).toBe(5);
    },
    timeout,
  );

  it(
    "keeps bot.send's dedupe and refusals: a resend and a refused send write no change",
    async () => {
      const { client, botId, user, deps } = await botWith([round(sends("Hello!"))]);
      const id = uuidv7();
      await send(client, botId, "Hi", id);
      const cursor = await cursorOf(client, botId);

      await send(client, botId, "Hi", id);
      expect(await changesAfter(client, botId, cursor)).toEqual([]);

      // Another user's send, and one on a Model no longer available, are refused.
      const other = chatRpc({ user: await insertUser(), deps });
      await expect(other.bot.send({ botId, id: uuidv7(), text: "Hi" })).rejects.toThrow(
        "Bot not found",
      );
      await expect(other.bot.changes({ botId, since: 0 })).rejects.toThrow("Bot not found");
      await deleteCredentials(deps, user.id, "openai");
      await expect(client.bot.send({ botId, id: uuidv7(), text: "Hi" })).rejects.toThrow(
        "is not an available Model",
      );
      expect(await changesAfter(client, botId, cursor)).toEqual([]);
    },
    timeout,
  );

  it(
    "writes one secret change when a Secret is saved, never its value, and one when it is deleted",
    async () => {
      const { client, botId } = await botWith([round(sends("Thanks, got it."))]);
      await client.bot.secret.save({ botId, name: "GITHUB_TOKEN", value: "ghp_secret-value-123" });
      await settled(botId);

      const changes = await changesAfter(client, botId, 0);
      const secrets = changes.filter((change) => change.kind === "secret");
      expect(secrets).toEqual([
        expect.objectContaining({
          refId: "GITHUB_TOKEN",
          data: { name: "GITHUB_TOKEN", createdAt: expect.any(Date) },
        }),
      ]);
      expect(JSON.stringify(changes)).not.toContain("ghp_secret-value-123");

      const cursor = await cursorOf(client, botId);
      await client.bot.secret.delete({ name: "GITHUB_TOKEN" });
      // Deleting it again changes nothing, so it writes no change.
      await client.bot.secret.delete({ name: "GITHUB_TOKEN" });
      expect(await changesAfter(client, botId, cursor)).toEqual([
        expect.objectContaining({
          seq: cursor + 1,
          kind: "secret",
          refId: "GITHUB_TOKEN",
          data: null,
        }),
      ]);
    },
    timeout,
  );

  it(
    "writes one routine change when a Routine is approved, and one pointing at nothing when another is declined",
    async () => {
      const routine = (name: string) =>
        toolCall({
          name: "create_routine",
          input: { name, prompt: "Summarize.", schedule: { days: ["mon"], at: "08:00" } },
        });
      const { client, botId } = await botWith([
        round(routine("morning-brief"), routine("evening-brief")),
        round(sends("Saved both.")),
      ]);
      await send(client, botId, "Make two Routines");
      const created = await changesAfter(client, botId, 0);
      expect(kindsOf(created).filter((kind) => kind === "routine")).toHaveLength(2);
      // By name: evening-brief, then morning-brief.
      const [evening, morning] = await getTestDb()
        .select()
        .from(botRoutine)
        .where(eq(botRoutine.botId, botId))
        .orderBy(asc(botRoutine.name));

      let cursor = await cursorOf(client, botId);
      await client.bot.routine.approve({ routineId: morning!.id });
      expect(await changesAfter(client, botId, cursor)).toEqual([
        expect.objectContaining({
          seq: cursor + 1,
          kind: "routine",
          refId: morning!.id,
          data: expect.objectContaining({ id: morning!.id, state: "active" }),
        }),
      ]);

      cursor += 1;
      await client.bot.routine.decline({ routineId: evening!.id });
      expect(await changesAfter(client, botId, cursor)).toEqual([
        expect.objectContaining({
          seq: cursor + 1,
          kind: "routine",
          refId: evening!.id,
          data: null,
        }),
      ]);
    },
    timeout,
  );

  it(
    "writes one check_in change when a Check-in is set and one when it is cancelled",
    async () => {
      const at = new Date(Date.now() + 60 * 60_000).toISOString();
      const { client, botId } = await botWith([
        round(toolCall({ name: "set_check_in", input: { at, note: "Has Acme replied?" } })),
        round(sends("I'll check in.")),
      ]);
      await send(client, botId, "Remind me about Acme");
      const set = (await changesAfter(client, botId, 0)).filter(
        (change) => change.kind === "check_in",
      );
      const [row] = await getTestDb().select().from(botCheckIn).where(eq(botCheckIn.botId, botId));
      expect(set).toEqual([
        expect.objectContaining({
          refId: row!.id,
          data: expect.objectContaining({ state: "pending" }),
        }),
      ]);

      const cursor = await cursorOf(client, botId);
      await client.bot.checkIn.cancel({ checkInId: row!.id });
      expect(await changesAfter(client, botId, cursor)).toEqual([
        expect.objectContaining({
          seq: cursor + 1,
          kind: "check_in",
          data: expect.objectContaining({ id: row!.id, state: "cancelled" }),
        }),
      ]);
    },
    timeout,
  );

  it(
    "writes one review change when the user decides a waiting Approval",
    async () => {
      const { client, botId } = await botWith([round(sends("Hello!"))]);
      await send(client, botId, "Hi");
      const [turn] = await turnsOf(botId);
      const reviewId = uuidv7();
      await getTestDb()
        .insert(botReview)
        .values({
          id: reviewId,
          botId,
          turnId: turn!.id,
          toolCallId: uuidv7(),
          tool: "shell",
          input: { command: "git push" },
          summary: "Pushes to GitHub",
          verdict: "block",
          reason: "The user never asked to push",
          state: "waiting",
          deadline: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        });
      const cursor = await cursorOf(client, botId);

      await client.bot.review.allow({ reviewId });
      // A second answer changes nothing, so it writes no change.
      await client.bot.review.deny({ reviewId });

      expect(await changesAfter(client, botId, cursor)).toEqual([
        expect.objectContaining({
          seq: cursor + 1,
          kind: "review",
          refId: reviewId,
          data: expect.objectContaining({ id: reviewId, state: "allowed" }),
        }),
      ]);
    },
    timeout,
  );

  it(
    "writes helper changes as a Helper starts, makes progress and ends",
    async () => {
      const { client, botId } = await botWith(
        [
          round(
            toolCall({ name: "start_helper", input: { type: "general", task: "Count files." } }),
            sends("On it."),
          ),
          round(sends("It found 3 files.")),
        ],
        [round(toolCall({ name: "shell", input: { command: "ls" } })), round(text("3 files."))],
      );
      await send(client, botId, "How many files?");
      await settled(botId);

      const helpers = (await changesAfter(client, botId, 0)).filter(
        (change) => change.kind === "helper",
      );
      const [row] = await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId));
      // Its start, a change before each of its 2 Steps, and its end.
      expect(helpers).toHaveLength(4);
      expect(helpers.every((change) => change.refId === row!.id)).toBe(true);
      expect(helpers.at(-1)!.data).toMatchObject({ status: "complete", steps: 2 });
    },
    timeout,
  );

  it(
    "leaves no gaps when writers to one Conversation run at the same time",
    async () => {
      const { client, botId } = await botWith();
      const names = Array.from({ length: 10 }, (_, index) => `TOKEN_${index}`);

      await Promise.all(
        names.map((name) => client.bot.secret.save({ botId, name, value: "a-long-secret-value" })),
      );
      await settled(botId);

      const changes = await changesAfter(client, botId, 0);
      expect(changes.map((change) => change.seq)).toEqual(changes.map((_, index) => index + 1));
      expect(changes.filter((change) => change.kind === "secret")).toHaveLength(10);
    },
    timeout,
  );

  it(
    `keeps the last ${retainedChanges} changes, and a cursor older than them, or past the newest, gets reload`,
    async () => {
      const { client, botId, conversationId } = await botWith();
      const total = retainedChanges + 5;
      await getTestDb().transaction(async (tx) => {
        for (let seq = 1; seq <= total; seq += 1) {
          await recordChange(tx, conversationId, { kind: "turn", refId: uuidv7(), at: new Date() });
        }
      });

      const kept = await getTestDb()
        .select({ seq: conversationChange.seq })
        .from(conversationChange)
        .where(eq(conversationChange.conversationId, conversationId))
        .orderBy(asc(conversationChange.seq));
      expect(kept).toHaveLength(retainedChanges);
      expect(kept[0]!.seq).toBe(total - retainedChanges + 1);

      const oldest = total - retainedChanges;
      expect(await changesAfter(client, botId, oldest)).toHaveLength(retainedChanges);
      expect(await client.bot.changes({ botId, since: oldest - 1 })).toEqual({ reload: true });
      expect(await client.bot.changes({ botId, since: 0 })).toEqual({ reload: true });
      expect(await client.bot.changes({ botId, since: total + 1 })).toEqual({ reload: true });
      expect(await changesAfter(client, botId, total)).toEqual([]);
    },
    timeout,
  );
});
