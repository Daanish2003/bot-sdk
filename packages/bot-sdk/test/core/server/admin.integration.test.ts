import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../core/server/assistant";
import { models } from "../../../plugins/models/server/plugin";
import { message, usage } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../support/conversations";
import { insertUser, type TestUser } from "../../support/users";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];
const basePath = "/api/chat";
const sonnet = "anthropic:claude-sonnet-5-5";

/** Records one call on Host credentials in `chat.usage`, at `createdAt`. */
async function record(
  userId: string,
  createdAt: Date,
  {
    costMicros,
    input,
    output,
    model = sonnet,
  }: { costMicros: number; input: number; output: number; model?: string },
) {
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId,
    kind: "run",
    model,
    inputTokens: input,
    outputTokens: output,
    costMicros,
    estimated: false,
    createdAt,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chat.plugin("models").usageTotals', () => {
  it("sums each user's calls in the range, and leaves out calls outside it", async () => {
    const heavy: TestUser = await insertUser();
    const light: TestUser = await insertUser();
    const since = new Date("2040-01-01T00:00:00Z");
    const until = new Date("2040-01-02T00:00:00Z");
    await record(heavy.id, new Date("2040-01-01T01:00:00Z"), {
      costMicros: 300,
      input: 100,
      output: 20,
    });
    await record(heavy.id, new Date("2040-01-01T23:00:00Z"), {
      costMicros: 50,
      input: 10,
      output: 5,
    });
    await record(light.id, new Date("2040-01-01T12:00:00Z"), {
      costMicros: 7,
      input: 1,
      output: 2,
    });
    // Just outside the range on either side: `since` is included, `until` is not.
    await record(light.id, new Date("2040-01-02T00:00:00Z"), {
      costMicros: 1_000,
      input: 1_000,
      output: 1_000,
    });
    await record(light.id, new Date("2039-12-31T23:59:59Z"), {
      costMicros: 1_000,
      input: 1_000,
      output: 1_000,
    });

    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });
    const totals = await chat.plugin("models").usageTotals({ since, until });

    expect(totals.find((row) => row.userId === heavy.id)).toEqual({
      userId: heavy.id,
      costMicros: 350,
      inputTokens: 110,
      outputTokens: 25,
      calls: 2,
    });
    expect(totals.find((row) => row.userId === light.id)).toEqual({
      userId: light.id,
      costMicros: 7,
      inputTokens: 1,
      outputTokens: 2,
      calls: 1,
    });
  });
});

describe('chat.plugin("models").usage', () => {
  it("groups one user's calls by UTC day and Model, in range, and leaves out other users", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const since = new Date("2040-01-01T00:00:00Z");
    const until = new Date("2040-01-03T00:00:00Z");
    const haiku = "anthropic:claude-haiku-5-5";
    await record(owner.id, new Date("2040-01-01T01:00:00Z"), {
      costMicros: 300,
      input: 100,
      output: 20,
    });
    await record(owner.id, new Date("2040-01-01T23:00:00Z"), {
      costMicros: 50,
      input: 10,
      output: 5,
    });
    await record(owner.id, new Date("2040-01-01T12:00:00Z"), {
      costMicros: 7,
      input: 1,
      output: 2,
      model: haiku,
    });
    await record(owner.id, new Date("2040-01-02T09:00:00Z"), {
      costMicros: 9,
      input: 3,
      output: 4,
    });
    // Outside the range on either side, and another user's call on the same day: all left out.
    await record(owner.id, new Date("2040-01-03T00:00:00Z"), {
      costMicros: 1_000,
      input: 1_000,
      output: 1_000,
    });
    await record(owner.id, new Date("2039-12-31T23:59:59Z"), {
      costMicros: 1_000,
      input: 1_000,
      output: 1_000,
    });
    await record(other.id, new Date("2040-01-01T12:00:00Z"), {
      costMicros: 1_000,
      input: 1_000,
      output: 1_000,
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });

    expect(await chat.plugin("models").usage({ userId: owner.id, since, until })).toEqual([
      { day: "2040-01-01", model: haiku, costMicros: 7, inputTokens: 1, outputTokens: 2, calls: 1 },
      {
        day: "2040-01-01",
        model: sonnet,
        costMicros: 350,
        inputTokens: 110,
        outputTokens: 25,
        calls: 2,
      },
      {
        day: "2040-01-02",
        model: sonnet,
        costMicros: 9,
        inputTokens: 3,
        outputTokens: 4,
        calls: 1,
      },
    ]);
  });
});

describe('chat.plugin("models").quota', () => {
  it("reports the budget and this window's spend in micros, with the reset time", async () => {
    vi.setSystemTime(new Date("2026-10-10T18:00:00Z"));
    const owner = await insertUser();
    await record(owner.id, new Date("2026-10-10T09:00:00Z"), {
      costMicros: 300_000,
      input: 0,
      output: 0,
    });
    // Yesterday's spend is not in today's window.
    await record(owner.id, new Date("2026-10-09T09:00:00Z"), {
      costMicros: 900_000,
      input: 0,
      output: 0,
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [
        models({
          getQuota: (userId) => (userId === owner.id ? { budgetUsd: 1, window: "day" } : null),
        }),
        assistant(),
      ],
    });

    expect(await chat.plugin("models").quota(owner.id)).toEqual({
      budgetMicros: 1_000_000,
      spentMicros: 300_000,
      window: "day",
      resetsAt: new Date("2026-10-11T00:00:00Z"),
    });
  });

  it("answers null for a user with no Quota, which is unlimited", async () => {
    const free = await insertUser();
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [
        models({
          getQuota: () => null,
        }),
        assistant(),
      ],
    });

    expect(await chat.plugin("models").quota(free.id)).toBeNull();
  });
});

describe("chat.admin.stopRuns", () => {
  it("ends the user's streaming Run as stopped, and leaves the other users' Runs alone", async () => {
    const owner = await insertUser();
    const bystander = await insertUser();
    const conv = await insertConversation(owner);
    const otherConv = await insertConversation(bystander);
    // No owner is alive: its last heartbeat is past the lease, so the Stop ends it here.
    const orphan = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Half",
      status: "streaming",
      heartbeatAt: new Date(Date.now() - 60_000),
    });
    const theirs = await insertMessage({
      conversationId: otherConv.id,
      role: "assistant",
      text: "Still going",
      status: "streaming",
      heartbeatAt: new Date(),
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });

    await chat.plugin("assistant").stopRuns(owner.id);

    const [ended] = await getTestDb().select().from(message).where(eq(message.id, orphan.id));
    expect(ended).toMatchObject({ status: "stopped", cancelRequestedAt: expect.any(Date) });
    const [untouched] = await getTestDb().select().from(message).where(eq(message.id, theirs.id));
    expect(untouched).toMatchObject({ status: "streaming", cancelRequestedAt: null });
  });

  it("asks a live Run to stop through its own owner, by setting cancel_requested_at", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner);
    const live = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Half",
      status: "streaming",
      heartbeatAt: new Date(),
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });

    await chat.plugin("assistant").stopRuns(owner.id);

    const [row] = await getTestDb().select().from(message).where(eq(message.id, live.id));
    expect(row).toMatchObject({ status: "streaming", cancelRequestedAt: expect.any(Date) });
  });
});

describe("chat.admin.ratingTotals", () => {
  it("counts 👍 and 👎 per Model over Ratings stamped at or after `since`, and leaves out older ones", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const conv = await insertConversation(owner);
    const otherConv = await insertConversation(other);
    const since = new Date("2040-01-10T00:00:00Z");
    const haiku = "anthropic:claude-haiku-5-5";
    const rated = (conversationId: string, model: string, rating: "up" | "down", ratedAt: Date) =>
      insertMessage({ conversationId, role: "assistant", text: "Hi", model, rating, ratedAt });
    await rated(conv.id, sonnet, "up", new Date("2040-01-10T00:00:00Z"));
    await rated(conv.id, sonnet, "down", new Date("2040-01-11T12:00:00Z"));
    await rated(otherConv.id, sonnet, "up", new Date("2040-01-12T08:00:00Z"));
    await rated(otherConv.id, haiku, "down", new Date("2040-01-13T08:00:00Z"));
    // Stamped before `since`, and never rated: both left out.
    await rated(conv.id, sonnet, "down", new Date("2040-01-09T23:59:59Z"));
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Unrated",
      model: sonnet,
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });

    const totals = await chat.plugin("assistant").ratingTotals({ since });

    expect(totals.sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      { model: haiku, up: 0, down: 1 },
      { model: sonnet, up: 2, down: 1 },
    ]);
  });

  it("drops a deleted Message's Rating from the totals", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner);
    const since = new Date("2040-01-10T00:00:00Z");
    const gone = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Gone",
      model: sonnet,
      rating: "down",
      ratedAt: new Date("2040-01-11T00:00:00Z"),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Kept",
      model: sonnet,
      rating: "up",
      ratedAt: new Date("2040-01-11T00:00:00Z"),
    });
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      plugins: [models(), assistant()],
    });
    expect(await chat.plugin("assistant").ratingTotals({ since })).toEqual([
      { model: sonnet, up: 1, down: 1 },
    ]);

    await getTestDb().delete(message).where(eq(message.id, gone.id));

    expect(await chat.plugin("assistant").ratingTotals({ since })).toEqual([
      { model: sonnet, up: 1, down: 0 },
    ]);
  });
});
