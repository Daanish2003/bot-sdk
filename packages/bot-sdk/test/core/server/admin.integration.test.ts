import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { bot as botPlugin } from "../../../plugins/bot/server/plugin";
import { models } from "../../../plugins/models/server/plugin";
import { botTurn, usage } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { HostProvider } from "../../../plugins/models/server/types";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "../../support/bot-turns";
import { createFakeAdapter, round, toolCall, withUsage } from "../../support/fake-adapter";
import { followSend } from "../../support/follow-send";
import { insertUser, type TestUser } from "../../support/users";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";

const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];
const basePath = "/api/chat";
const sonnet = "anthropic:claude-sonnet-5-5";
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host" },
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
    kind: "turn",
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

describe("chat.models.usageTotals", () => {
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
      plugins: [models(), botPlugin()],
    });
    const totals = await chat.models.usageTotals({ since, until });

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

describe("chat.models.usage", () => {
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
      plugins: [models(), botPlugin()],
    });

    expect(await chat.models.usage({ userId: owner.id, since, until })).toEqual([
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

describe("chat.models.quota", () => {
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
        botPlugin(),
      ],
    });

    expect(await chat.models.quota(owner.id)).toEqual({
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
        botPlugin(),
      ],
    });

    expect(await chat.models.quota(free.id)).toBeNull();
  });
});

describe("Admin over a Bot's Turns", () => {
  afterEach(stopBotRunners);

  it("counts a Turn's model calls on Host credentials in the usage totals, the usage and the Quota", async () => {
    // A real Turn: the runner and the Turn's clock run on real time.
    vi.useRealTimers();
    const owner = await insertUser();
    const fake = createFakeAdapter({
      rounds: [
        withUsage(
          round(toolCall({ name: "send_to_user", input: { text: "Hello", endTurn: true } })),
          { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        ),
      ],
    });
    const { deps } = await botSdk({
      hostProviders,
      adapterFor: () => fake.adapter,
      getQuota: async () => ({ budgetUsd: 1, window: "day" }),
    });
    const { client, botId } = await botOf(deps, owner, sonnet);
    const since = new Date(Date.now() - 60_000);

    await sendToTurnEnd(client, botId);

    const until = new Date(Date.now() + 60_000);
    const modelsApi = deps.models;
    // 100 × $3/M + 50 × $15/M = 1050 micros.
    expect(
      (await modelsApi.usageTotals({ since, until })).find((row) => row.userId === owner.id),
    ).toEqual({
      userId: owner.id,
      costMicros: 1050,
      inputTokens: 100,
      outputTokens: 50,
      calls: 1,
    });
    expect(await modelsApi.usage({ userId: owner.id, since, until })).toEqual([
      expect.objectContaining({ model: sonnet, costMicros: 1050, calls: 1 }),
    ]);
    expect(await modelsApi.quota(owner.id)).toMatchObject({
      budgetMicros: 1_000_000,
      spentMicros: 1050,
    });
  });
});

describe("a Ban: chat.bots.stopTurns", () => {
  afterEach(stopBotRunners);

  it("ends the banned user's Turn stopped, and leaves another user's Turn alone", async () => {
    vi.useRealTimers();
    // An idle runner takes no Turn, so both stay running until the Ban.
    const { deps } = await botSdk({ hostProviders }, { idle: true });
    const owner = await insertUser();
    const bystander = await insertUser();
    const own = await botOf(deps, owner, sonnet);
    const theirs = await botOf(deps, bystander, sonnet);
    for (const { client, botId } of [own, theirs]) {
      await followSend(client, { botId, id: uuidv7(), text: "Hi" });
    }

    await deps.bots.stopTurns(owner.id);

    const statusOf = async (botId: string) =>
      (await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId))).map(
        (turn) => turn.status,
      );
    expect(await statusOf(own.botId)).toEqual(["stopped"]);
    expect(await statusOf(theirs.botId)).toEqual(["running"]);
  });
});
