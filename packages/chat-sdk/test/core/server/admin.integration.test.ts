import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChat } from "../../../core/server/create-chat";
import { message } from "../../../core/server/db/schema/chat";
import { usage } from "../../../core/server/db/schema/usage";
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

describe("chat.admin.usageTotals", () => {
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

    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
    });
    const totals = await chat.admin.usageTotals({ since, until });

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

describe("chat.admin.usage", () => {
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
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
    });

    expect(await chat.admin.usage({ userId: owner.id, since, until })).toEqual([
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

describe("chat.admin.quota", () => {
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
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      getQuota: (userId) => (userId === owner.id ? { budgetUsd: 1, window: "day" } : null),
    });

    expect(await chat.admin.quota(owner.id)).toEqual({
      budgetMicros: 1_000_000,
      spentMicros: 300_000,
      window: "day",
      resetsAt: new Date("2026-10-11T00:00:00Z"),
    });
  });

  it("answers null for a user with no Quota, which is unlimited", async () => {
    const free = await insertUser();
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
      getQuota: () => null,
    });

    expect(await chat.admin.quota(free.id)).toBeNull();
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
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
    });

    await chat.admin.stopRuns(owner.id);

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
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets,
      basePath,
    });

    await chat.admin.stopRuns(owner.id);

    const [row] = await getTestDb().select().from(message).where(eq(message.id, live.id));
    expect(row).toMatchObject({ status: "streaming", cancelRequestedAt: expect.any(Date) });
  });
});
