import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot as botTable, botPromptStart, botTurn, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { claimJob } from "../../../../plugins/runner/server/jobs/store";
import { createFakeAdapter, round, text, withUsage } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { followSend } from "../../../support/follow-send";

const silent = { error: () => {} };
const minute = 60_000;
const oneHour = { type: "ephemeral", ttl: "1h" };

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with a key for `modelId`'s Provider and a Bot "Ada" on it, over a Model that plays `rounds`. */
async function botWith(
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"],
  modelId: string,
  { linked = false } = {},
) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: systemClock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot()],
    memory: false,
    jobs,
    adapterFor: () => fake.adapter,
    ...(linked && { linkedCredentials: async () => ({ apiKey: "plan-token" }) }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!linked) {
    await saveCredentials(deps, user.id, {
      service: modelId.split(":")[0]!,
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model: modelId });
  return { fake, deps, jobs, user, client, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text })) {
    // Read to the end of the Turn.
  }
}

/**
 * Makes the user's recorded model calls `minutes` old, as if the Turn ran that long ago, and their
 * Bots' Prompt starts as old, so no Prompt start is newer than the calls that sent it.
 */
const ageCalls = async (userId: string, minutes: number) => {
  const at = new Date(Date.now() - minutes * minute);
  await getTestDb().update(usage).set({ createdAt: at }).where(eq(usage.userId, userId));
  await getTestDb()
    .update(botPromptStart)
    .set({ builtAt: new Date(at.getTime() - 1000) })
    .where(
      inArray(
        botPromptStart.botId,
        getTestDb().select({ id: botTable.id }).from(botTable).where(eq(botTable.userId, userId)),
      ),
    );
};

const usageKinds = async (userId: string) =>
  (
    await getTestDb()
      .select()
      .from(usage)
      .where(eq(usage.userId, userId))
      .orderBy(asc(usage.createdAt))
  ).map((row) => row.kind);

/** What a warming call reports: the prompt written to the cache. */
const written = { promptTokens: 40, completionTokens: 0, totalTokens: 40 };
const warmRound = () =>
  withUsage(round(), { ...written, promptTokensDetails: { cacheWriteTokens: 40 } });

describe("bot.warm", () => {
  it("warms an Anthropic Bot's stored Prompt start and history with max_tokens 0 and the 1-hour breakpoints", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    expect(await client.bot.warm({ botId })).toEqual({ warmed: true });

    expect(fake.calls).toHaveLength(2);
    const [turnCall, warm] = fake.calls as [TextOptions, TextOptions];
    const [start] = await getTestDb()
      .select()
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId));
    // The Prompt start, then everything the Turn left in the history, with the Turn's breakpoints.
    expect(warm.modelOptions).toEqual({ cache_control: oneHour, max_tokens: 0 });
    expect(JSON.parse(JSON.stringify(warm.tools))).toEqual(start!.tools);
    expect(warm.systemPrompts).toEqual(turnCall.systemPrompts);
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    const messages = warm.messages as ModelMessage[];
    expect(messages.slice(1)).toEqual([...turn!.input!, ...turn!.transcript!]);
    const [first] = messages[0]!.content as { content: string }[];
    expect(first!.content).toBe(start!.sections.at(-1)!.text);
    expect(JSON.stringify(messages[0]?.content)).toContain('"cache_control"');
  });

  it("after a Summary while away, sends what the next Turn's first call sends before its newest message", async () => {
    const { fake, jobs, user, client, botId } = await botWith(
      [
        withUsage(round(), { promptTokens: 120_000, completionTokens: 10, totalTokens: 120_010 }),
        // The away Summary.
        round(text("The user said hi.")),
        warmRound(),
        round(),
      ],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    // The away Summary, run now rather than 10 minutes on.
    const claimed = await claimJob(getTestDb(), new Date(), {
      respectRunAfter: false,
      names: { only: ["bot.summarize-away"] },
    });
    await jobs.runClaimed(claimed!);
    expect(
      await getTestDb().select().from(botPromptStart).where(eq(botPromptStart.botId, botId)),
    ).toHaveLength(2);
    await ageCalls(user.id, 56);

    expect(await client.bot.warm({ botId })).toEqual({ warmed: true });
    await send(client, botId, "back again");

    expect(fake.calls).toHaveLength(4);
    const [, , warm, next] = fake.calls as TextOptions[];
    // Where the cache breakpoints sit differs; the prompt itself must not.
    const plain = (messages: TextOptions["messages"]) =>
      JSON.parse(
        JSON.stringify(messages, (key, value) => (key === "cache_control" ? undefined : value)),
      );
    const warmed = plain(warm!.messages);
    expect(plain(next!.messages).slice(0, warmed.length)).toEqual(warmed);
    expect(next!.messages.length).toBeGreaterThan(warmed.length);
  });

  it("is recorded as a warm call with the Bot as its source, and shown by bot.get", async () => {
    const { user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    await client.bot.warm({ botId });

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    const warm = rows.find((row) => row.kind === "warm");
    expect(warm).toMatchObject({ sourceId: botId, cacheWriteTokens: 40, inputTokens: 80 });
    expect((await client.bot.get({ botId })).warmings).toEqual([
      { id: warm!.id, at: warm!.createdAt, costMicros: warm!.costMicros },
    ]);
  });

  it("warms an OpenAI GPT-5.6 Bot with prompt_cache_options.prewarm and its prompt_cache_key", async () => {
    const { fake, user, client, botId } = await botWith([round(), warmRound()], "openai:gpt-5.6");
    await send(client, botId, "hi");
    await ageCalls(user.id, 26);

    expect(await client.bot.warm({ botId })).toEqual({ warmed: true });

    expect(fake.calls.at(-1)?.modelOptions).toEqual({
      prompt_cache_key: `bot:${botId}`,
      prompt_cache_options: { prewarm: true },
    });
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });

  it("skips while the Bot's last call is within the cache lifetime minus 5 minutes", async () => {
    const anthropic = await botWith([round(), warmRound()], "anthropic:claude-sonnet-5-5");
    await send(anthropic.client, anthropic.botId, "hi");
    await ageCalls(anthropic.user.id, 54);
    expect(await anthropic.client.bot.warm({ botId: anthropic.botId })).toEqual({
      warmed: false,
      skipped: "still_warm",
    });
    expect(anthropic.fake.calls).toHaveLength(1);

    const openai = await botWith([round(), warmRound()], "openai:gpt-5.6");
    await send(openai.client, openai.botId, "hi");
    await ageCalls(openai.user.id, 24);
    expect(await openai.client.bot.warm({ botId: openai.botId })).toEqual({
      warmed: false,
      skipped: "still_warm",
    });
    expect(openai.fake.calls).toHaveLength(1);
  });

  it("counts a warm as a call, so a second warm right after skips", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    await client.bot.warm({ botId });
    expect(await client.bot.warm({ botId })).toEqual({ warmed: false, skipped: "still_warm" });

    expect(fake.calls).toHaveLength(2);
  });

  it("warms once when two tabs ask at the same time", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    const results = await Promise.all([client.bot.warm({ botId }), client.bot.warm({ botId })]);

    expect(results).toEqual(
      expect.arrayContaining([{ warmed: true }, { warmed: false, skipped: "still_warm" }]),
    );
    expect(fake.calls).toHaveLength(2);
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });

  it("warms after a Summary while away, whose new Prompt start no call has cached yet", async () => {
    const { fake, jobs, client, botId } = await botWith(
      [
        withUsage(round(), { promptTokens: 120_000, completionTokens: 10, totalTokens: 120_010 }),
        // The away Summary.
        round(text("The user said hi.")),
        warmRound(),
      ],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    const claimed = await claimJob(getTestDb(), new Date(), {
      respectRunAfter: false,
      names: { only: ["bot.summarize-away"] },
    });
    await jobs.runClaimed(claimed!);

    // The Turn's call was moments ago, but before the new Prompt start was built.
    expect(await client.bot.warm({ botId })).toEqual({ warmed: true });
    expect(fake.calls).toHaveLength(3);
  });

  it("skips while a Turn runs", async () => {
    const { fake, user, client, botId } = await botWith([round(), warmRound()], "openai:gpt-5.6");
    await send(client, botId, "hi");
    await ageCalls(user.id, 60);
    await getTestDb().update(botTurn).set({ status: "running" }).where(eq(botTurn.botId, botId));

    expect(await client.bot.warm({ botId })).toEqual({ warmed: false, skipped: "running" });

    expect(fake.calls).toHaveLength(1);
  });

  it("skips a Bot with no Prompt start yet", async () => {
    const { fake, client, botId } = await botWith([warmRound()], "anthropic:claude-sonnet-5-5");

    expect(await client.bot.warm({ botId })).toEqual({ warmed: false, skipped: "nothing_cached" });

    expect(fake.calls).toHaveLength(0);
  });

  it.each(["gemini:gemini-3.8-flash", "openai:gpt-5.4-mini"])(
    "makes no warming call on %s",
    async (modelId) => {
      const { fake, user, client, botId } = await botWith([round(), warmRound()], modelId);
      await send(client, botId, "hi");
      await ageCalls(user.id, 120);

      expect(await client.bot.warm({ botId })).toEqual({ warmed: false, skipped: "unsupported" });

      expect(fake.calls).toHaveLength(1);
    },
  );

  it("makes no warming call on the ChatGPT plan, which caches nothing", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "openai:gpt-6.1-sol",
      {
        linked: true,
      },
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 120);

    expect(await client.bot.warm({ botId })).toEqual({ warmed: false, skipped: "unsupported" });

    expect(fake.calls).toHaveLength(1);
  });

  it("is refused for another user's Bot", async () => {
    const { deps, user, client, botId } = await botWith([round(), warmRound()], "openai:gpt-5.6");
    await send(client, botId, "hi");
    await ageCalls(user.id, 60);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.warm({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await usageKinds(user.id)).toEqual(["turn"]);
  });
});
