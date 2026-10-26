import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot, botTurn, usage } from "../../../../core/server/storage";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import type { HostProvider } from "../../../../plugins/models/server/internal";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "../../../support/bot-turns";
import {
  createFakeAdapter,
  round,
  runError,
  toolCall,
  withUsage,
} from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { getTestDb } from "../../../support/test-database";

const sonnet = "anthropic:claude-sonnet-5-5";
const bedrockSonnet = "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0";
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
  {
    provider: "bedrock",
    credentials: { apiKey: "ABSK-host-secret-never-stored", region: "us-east-1" },
    models: [
      {
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];

/** A Step that sends `text` to the user, ending the Turn or not. */
const sends = (text: string, endTurn = true) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn } }));

const tokens = (input: number, output: number, cost?: number) => ({
  promptTokens: input,
  completionTokens: output,
  totalTokens: input + output,
  ...(cost !== undefined && { cost }),
});

afterEach(stopBotRunners);

/** A user with a Bot on the Host's Model, whose Turns play `rounds`. */
async function setup({
  user,
  model = sonnet,
  rounds,
}: {
  user?: TestUser;
  model?: string;
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds });
  const { deps } = await botSdk({ hostProviders, adapterFor: () => fake.adapter });
  const { client, botId } = await botOf(deps, owner, model);
  return { owner, deps, client, botId };
}

/** The usage rows of a user, without their ids and creation times, oldest first. */
async function usageOf(userId: string) {
  const rows = await getTestDb()
    .select()
    .from(usage)
    .where(eq(usage.userId, userId))
    .orderBy(usage.createdAt);
  return rows.map(({ id: _id, createdAt: _createdAt, ...row }) => row);
}

describe("usage for a Bot's Turn", () => {
  it("writes one row per model call on a Host Model, priced from the tokens it used", async () => {
    const { owner, client, botId } = await setup({
      rounds: [withUsage(sends("Hello"), tokens(100, 50))],
    });

    await sendToTurnEnd(client, botId);

    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    expect(await usageOf(owner.id)).toEqual([
      {
        userId: owner.id,
        kind: "turn",
        model: sonnet,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sourceId: turn!.id,
        promptHashes: expect.anything(),
        // 100 × $3/M + 50 × $15/M = $0.00105
        costMicros: 1050,
        estimated: false,
      },
    ]);
  });

  it("writes the same Model's calls on the user's own key at cost 0", async () => {
    const owner = await insertUser();
    const { deps, client, botId } = await setup({
      user: owner,
      rounds: [withUsage(sends("Hello"), tokens(100, 50))],
    });
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await sendToTurnEnd(client, botId);

    expect(await usageOf(owner.id)).toMatchObject([
      { inputTokens: 100, outputTokens: 50, costMicros: 0 },
    ]);
  });

  it("uses the cost the Provider reports over the tokens times the Model's price", async () => {
    const { owner, client, botId } = await setup({
      rounds: [withUsage(sends("Hello"), tokens(100, 50, 0.002))],
    });

    await sendToTurnEnd(client, botId);

    expect(await usageOf(owner.id)).toMatchObject([{ costMicros: 2000, estimated: false }]);
  });

  it("prices each model call of a Turn on its own", async () => {
    const { owner, client, botId } = await setup({
      rounds: [
        withUsage(sends("First", false), tokens(100, 50, 0.002)),
        withUsage(sends("Second"), tokens(10, 5)),
      ],
    });

    await sendToTurnEnd(client, botId);

    // The first call's reported cost; the second's tokens: 10 × $3/M + 5 × $15/M = 105 micros.
    expect(await usageOf(owner.id)).toMatchObject([
      { inputTokens: 100, outputTokens: 50, costMicros: 2000 },
      { inputTokens: 10, outputTokens: 5, costMicros: 105 },
    ]);
  });

  it("estimates a call that reported no usage, from its characters, and marks it estimated", async () => {
    const { owner, client, botId } = await setup({ rounds: [sends("Hello")] });

    await sendToTurnEnd(client, botId);

    const [row] = await usageOf(owner.id);
    expect(row).toMatchObject({ estimated: true });
    expect(row?.outputTokens).toBeGreaterThan(0);
    expect(row?.costMicros).toBe((row?.inputTokens ?? 0) * 3 + (row?.outputTokens ?? 0) * 15);
  });

  it("bills nothing for a call that failed without reporting usage", async () => {
    const { owner, client, botId } = await setup({ rounds: [round(runError("Overloaded"))] });

    const events = await sendToTurnEnd(client, botId);

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "error" });
    expect(await usageOf(owner.id)).toEqual([]);
  });

  // Their 1.0 adapters report input with its cache reads and writes in it, as other Providers do.
  it.each([sonnet, bedrockSonnet])(
    "counts the cache reads and writes of %s once",
    async (model) => {
      const { owner, client, botId } = await setup({
        model,
        rounds: [
          withUsage(sends("Hello"), {
            ...tokens(1000, 50),
            promptTokensDetails: { cachedTokens: 800, cacheWriteTokens: 100 },
          }),
        ],
      });

      await sendToTurnEnd(client, botId);

      expect(await usageOf(owner.id)).toMatchObject([
        { model, inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 50 },
      ]);
    },
  );

  it("keeps the usage when its Bot is deleted", async () => {
    const { owner, client, botId } = await setup({
      rounds: [withUsage(sends("Hello"), tokens(100, 50))],
    });
    await sendToTurnEnd(client, botId);

    await getTestDb().delete(bot).where(eq(bot.id, botId));

    expect(await usageOf(owner.id)).toHaveLength(1);
  });
});
