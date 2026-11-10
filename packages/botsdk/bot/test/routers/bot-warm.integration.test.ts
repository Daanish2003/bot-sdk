import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { asc, eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  databaseOf,
  bot as botTable,
  botPromptStart,
  botSummary,
  botTurn,
  message,
  usage,
} from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, systemClock, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "@ai-chat/test-support/deps";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  text,
  withUsage,
} from "@botsdk/testing/fake-adapter";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { followSend } from "@ai-chat/test-support/follow-send";

const silent = { error: () => {} };
const minute = 60_000;
const oneHour = { type: "ephemeral", ttl: "1h" };

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with a key for `modelId`'s Provider and a Bot "Ada" on it, over a Model that plays `rounds`. */
async function botWith(
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"],
  modelId: string,
  {
    linked = false,
    adapterFor,
    logger = silent,
    hostProviders,
    getQuota,
  }: {
    linked?: boolean;
    adapterFor?: TestDepsOverrides["adapterFor"];
    logger?: TestDepsOverrides["logger"];
  } & Pick<TestDepsOverrides, "hostProviders" | "getQuota"> = {},
) {
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: systemClock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    memory: false,
    jobs,
    logger,
    adapterFor: adapterFor ?? (() => fake.adapter),
    ...(linked && { linkedCredentials: async () => ({ apiKey: "plan-token" }) }),
    ...(hostProviders && { hostProviders }),
    ...(getQuota && { getQuota }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!linked && !hostProviders) {
    await saveCredentials(deps, user.id, {
      service: modelId.split(":")[0]!,
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model: modelId });
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

/** An Anthropic Messages stream with `blocks` as its content, stopped for `stopReason`. */
function anthropicStream(
  blocks: Record<string, unknown>[],
  stopReason: string,
  usage: Record<string, number>,
): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
    ...blocks.flatMap(({ delta, ...content_block }, index) => [
      { type: "content_block_start", index, content_block },
      ...(delta ? [{ type: "content_block_delta", index, delta }] : []),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

/** What a warm can have time to start in its one output token. */
const warmReplies: [string, Record<string, unknown>][] = [
  ["text", { type: "text", text: "", delta: { type: "text_delta", text: "Warmed-reply-text" } }],
  ["a tool call", { type: "tool_use", id: "toolu_1", name: "Warmed-reply-text", input: {} }],
  [
    "thinking",
    {
      type: "thinking",
      thinking: "",
      delta: { type: "thinking_delta", thinking: "Warmed-reply-text" },
    },
  ],
];

/** A wait a test holds open: it knows once something reached it, and lets that go on. */
function hold() {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => gate.resolve(),
    wait: () => {
      reached.resolve();
      return gate.promise;
    },
  };
}

/** Holds the Model call at `index` (from 0), which keeps its scripted round, until released. */
function holdModelCall(fake: FakeAdapter, index: number) {
  const held = hold();
  const play = fake.adapter.chatStream;
  fake.adapter.chatStream = async function* (options: TextOptions) {
    const iterator = play(options)[Symbol.asyncIterator]();
    const mine = fake.calls.length;
    const first = iterator.next();
    if (mine === index) await held.wait();
    for (let next = await first; !next.done; next = await iterator.next()) yield next.value;
  } as typeof fake.adapter.chatStream;
  return held;
}

/** Takes, and at once gives back, an exclusive lock on every table a warm reads or writes. */
const lockWarmTables = () =>
  getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw("set local lock_timeout = '2s'"));
    await tx.execute(
      sql`lock table ${usage}, ${botPromptStart}, ${botSummary}, ${botTurn}, ${botTable}, ${message} in access exclusive mode`,
    );
  });

/** Whether an exclusive lock on `usage` is queued, in this test's database. */
const lockQueuedOnUsage = async () => {
  const { rows } = await getTestDb().execute<{ queued: boolean }>(
    sql`select exists (select 1 from pg_locks where not granted and relation = 'botsdk.usage'::regclass and database = (select oid from pg_database where datname = current_database())) as queued`,
  );
  return rows[0]?.queued === true;
};

/**
 * Whether any session holds the Bot's warm lock. A pooled connection can take its own lock again, so
 * a lock never let go wouldn't show as a later warm skipping.
 */
const warmLockHeld = async (botId: string) => {
  const { rows } = await getTestDb().execute<{ held: boolean }>(
    sql`select exists (select 1 from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database()) and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`warm:${botId}`}, 0)) as held`,
  );
  return rows[0]?.held === true;
};

describe("bot.warm", () => {
  // The real adapter, so its own checks of the request run, over a stubbed `fetch`.
  it.each(warmReplies)(
    "warms through the real Anthropic adapter when the 1-token reply starts %s, and keeps none of it",
    async (_start, block) => {
      const finished = () => anthropicStream([], "end_turn", { input_tokens: 10 });
      const responses = [
        finished(),
        anthropicStream([block], "max_tokens", {
          input_tokens: 10,
          cache_creation_input_tokens: 40,
        }),
        finished(),
      ];
      const requests: Record<string, unknown>[] = [];
      const errors: unknown[][] = [];
      const { user, client, botId } = await botWith([], "anthropic:claude-sonnet-5-5", {
        adapterFor: (model, credentials) =>
          createAnthropicChat(model.split(":")[1] as "claude-sonnet-5-5", credentials.apiKey!, {
            fetch: async (_url, init) => {
              requests.push(JSON.parse(String(init?.body)));
              return responses.shift()!;
            },
          }),
        logger: { error: (...args: unknown[]) => errors.push(args) },
      });
      await send(client, botId, "hi");
      await ageCalls(user.id, 56);
      const [turnBefore] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));

      expect(await client.bots.warm({ botId })).toEqual({ warmed: true });

      expect(errors).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ max_tokens: 1, stream: true });
      const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
      expect(rows.find((row) => row.kind === "warm")).toMatchObject({
        cacheWriteTokens: 40,
        outputTokens: 1,
      });
      const [turnAfter] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
      expect(turnAfter!.transcript).toEqual(turnBefore!.transcript);

      await send(client, botId, "back again");
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2]!.messages)).not.toContain("Warmed-reply-text");
    },
  );

  it("warms an Anthropic Bot's stored Prompt start and history with max_tokens 1 and the 1-hour breakpoints", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    expect(await client.bots.warm({ botId })).toEqual({ warmed: true });

    expect(fake.calls).toHaveLength(2);
    const [turnCall, warm] = fake.calls as [TextOptions, TextOptions];
    expect(warm.threadId).toBe(botId);
    const [start] = await getTestDb()
      .select()
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId));
    // The Prompt start, then everything the Turn left in the history, with the Turn's breakpoints.
    expect(warm.modelOptions).toEqual({ cache_control: oneHour, max_tokens: 1 });
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

    expect(await client.bots.warm({ botId })).toEqual({ warmed: true });
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

    await client.bots.warm({ botId });

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    const warm = rows.find((row) => row.kind === "warm");
    expect(warm).toMatchObject({ sourceId: botId, cacheWriteTokens: 40, inputTokens: 40 });
    expect((await client.bots.get({ botId })).warmings).toEqual([
      { id: warm!.id, at: warm!.createdAt, costMicros: warm!.costMicros },
    ]);
  });

  it("warms an OpenAI GPT-6 Luna Bot with prompt_cache_options.prewarm and its prompt_cache_key", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "openai:gpt-6-luna",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 26);

    expect(await client.bots.warm({ botId })).toEqual({ warmed: true });

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
    expect(await anthropic.client.bots.warm({ botId: anthropic.botId })).toEqual({
      warmed: false,
      skipped: "still_warm",
    });
    expect(anthropic.fake.calls).toHaveLength(1);
  });

  // Its own test: a second `botWith` in one test starts a second runner, and either runner may
  // claim a Turn (#950).
  it("skips an OpenAI Bot within its cache lifetime minus 5 minutes", async () => {
    const openai = await botWith([round(), warmRound()], "openai:gpt-6-luna");
    await send(openai.client, openai.botId, "hi");
    await ageCalls(openai.user.id, 24);
    expect(await openai.client.bots.warm({ botId: openai.botId })).toEqual({
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

    await client.bots.warm({ botId });
    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "still_warm" });

    expect(fake.calls).toHaveLength(2);
  });

  it("warms once when two tabs ask at the same time", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);

    const results = await Promise.all([client.bots.warm({ botId }), client.bots.warm({ botId })]);

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
    expect(await client.bots.warm({ botId })).toEqual({ warmed: true });
    expect(fake.calls).toHaveLength(3);
  });

  it("skips while a Turn runs", async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "openai:gpt-6-luna",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 60);
    await getTestDb().update(botTurn).set({ status: "running" }).where(eq(botTurn.botId, botId));

    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "running" });

    expect(fake.calls).toHaveLength(1);
  });

  it("skips a Bot with no Prompt start yet", async () => {
    const { fake, client, botId } = await botWith([warmRound()], "anthropic:claude-sonnet-5-5");

    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "nothing_cached" });

    expect(fake.calls).toHaveLength(0);
  });

  it.each(["gemini:gemini-3.8-flash", "openai:gpt-5.4-mini"])(
    "makes no warming call on %s",
    async (modelId) => {
      const { fake, user, client, botId } = await botWith([round(), warmRound()], modelId);
      await send(client, botId, "hi");
      await ageCalls(user.id, 120);

      expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "unsupported" });

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

    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "unsupported" });

    expect(fake.calls).toHaveLength(1);
  });

  it("is refused for another user's Bot", async () => {
    const { deps, user, client, botId } = await botWith(
      [round(), warmRound()],
      "openai:gpt-6-luna",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 60);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bots.warm({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await usageKinds(user.id)).toEqual(["turn"]);
  });
});

describe("a warm holds no transaction across its Model call", () => {
  const timeout = 30_000;
  const hostProviders: NonNullable<TestDepsOverrides["hostProviders"]> = [
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

  it("lets an exclusive lock through while it waits on its Model", { timeout }, async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);
    const held = holdModelCall(fake, 1);

    const warm = client.bots.warm({ botId });
    await held.reached;
    try {
      await lockWarmTables();
    } finally {
      held.release();
    }

    expect(await warm).toEqual({ warmed: true });
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });

  // The hang itself, with no Model call to wait for: a Quota check reads `usage` on another
  // connection, behind an exclusive lock that waits for whatever already read `usage`.
  it(
    "never hangs an exclusive lock queued while its Quota check is on the way",
    { timeout },
    async () => {
      const held = hold();
      let holding = false;
      const { fake, user, client, botId } = await botWith(
        [round(), warmRound()],
        "anthropic:claude-sonnet-5-5",
        {
          hostProviders,
          getQuota: async () => {
            if (holding) await held.wait();
            return { budgetUsd: 100, window: "month" };
          },
        },
      );
      await send(client, botId, "hi");
      await ageCalls(user.id, 56);
      holding = true;

      const warm = client.bots.warm({ botId });
      await held.reached;
      let settled = false;
      const lock = getTestDb()
        .transaction(async (tx) => {
          await tx.execute(sql.raw("set local lock_timeout = '2s'"));
          await tx.execute(sql`lock table ${usage} in access exclusive mode`);
        })
        .finally(() => {
          settled = true;
        });
      try {
        await expect.poll(async () => settled || (await lockQueuedOnUsage())).toBe(true);
      } finally {
        held.release();
      }

      await lock;
      expect(await warm).toEqual({ warmed: true });
      expect(fake.calls).toHaveLength(2);
    },
  );

  it("runs one warm at a time, while its Model call waits and after", { timeout }, async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);
    const held = holdModelCall(fake, 1);

    const first = client.bots.warm({ botId });
    await held.reached;
    expect(await warmLockHeld(botId)).toBe(true);
    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "still_warm" });
    held.release();
    expect(await first).toEqual({ warmed: true });
    expect(await warmLockHeld(botId)).toBe(false);

    // Sees the first warm's row.
    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "still_warm" });
    expect(fake.calls).toHaveLength(2);
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });

  it("skips, seeing the row, when another warm ended while it got ready", { timeout }, async () => {
    const preparing = hold();
    let holding = false;
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound(), warmRound()],
      "anthropic:claude-sonnet-5-5",
      {
        hostProviders,
        getQuota: async () => {
          if (holding) await preparing.wait();
          return { budgetUsd: 100, window: "month" };
        },
      },
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);
    const inCall = holdModelCall(fake, 1);

    const first = client.bots.warm({ botId });
    await inCall.reached;
    holding = true;
    const second = client.bots.warm({ botId });
    await preparing.reached;
    inCall.release();
    expect(await first).toEqual({ warmed: true });
    preparing.release();

    expect(await second).toEqual({ warmed: false, skipped: "still_warm" });
    expect(fake.calls).toHaveLength(2);
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });

  /** A cold Bot with a Host Model whose next Quota read waits, as a warm gets ready. */
  async function warmHeldGettingReady() {
    const preparing = hold();
    let holding = false;
    const made = await botWith([round(), warmRound()], "anthropic:claude-sonnet-5-5", {
      hostProviders,
      getQuota: async () => {
        if (holding) await preparing.wait();
        return { budgetUsd: 100, window: "month" };
      },
    });
    await send(made.client, made.botId, "hi");
    await ageCalls(made.user.id, 56);
    holding = true;
    return { ...made, preparing };
  }

  it("skips when a Turn started while it got ready", { timeout }, async () => {
    const { fake, client, botId, preparing } = await warmHeldGettingReady();

    const warm = client.bots.warm({ botId });
    await preparing.reached;
    await getTestDb().update(botTurn).set({ status: "running" }).where(eq(botTurn.botId, botId));
    preparing.release();

    expect(await warm).toEqual({ warmed: false, skipped: "running" });
    expect(fake.calls).toHaveLength(1);
  });

  it("makes no call when a new Prompt start arrived while it got ready", { timeout }, async () => {
    const { fake, client, botId, preparing } = await warmHeldGettingReady();

    const warm = client.bots.warm({ botId });
    await preparing.reached;
    const [start] = await getTestDb()
      .select()
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId));
    await getTestDb()
      .insert(botPromptStart)
      .values({ ...start!, id: uuidv7(), builtAt: new Date() });
    preparing.release();

    expect(await warm).toEqual({ warmed: false, skipped: "still_warm" });
    expect(fake.calls).toHaveLength(1);
  });

  // Warms holding every connection of a pool must not each wait for one more.
  it("needs no second connection while it holds its lock", { timeout }, async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);
    const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
    try {
      const small = createTestSdk({
        memory: false,
        logger: silent,
        db: databaseOf({ pool }),
        adapterFor: () => fake.adapter,
      });

      const warmed = await Promise.race([
        chatRpc({ user, deps: small }).bots.warm({ botId }),
        new Promise((resolve) => setTimeout(() => resolve("stuck"), 10_000)),
      ]);

      expect(warmed).toEqual({ warmed: true });
      expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
    } finally {
      await pool.end();
    }
  });

  it(
    "warms on, logging it, when its lock's connection dies during the call",
    { timeout },
    async () => {
      const errors: unknown[][] = [];
      const { fake, user, client, botId } = await botWith(
        [round(), warmRound()],
        "anthropic:claude-sonnet-5-5",
        { logger: { error: (...args: unknown[]) => errors.push(args) } },
      );
      await send(client, botId, "hi");
      await ageCalls(user.id, 56);
      const held = holdModelCall(fake, 1);

      const warm = client.bots.warm({ botId });
      await held.reached;
      try {
        await getTestDb().execute(
          sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database()) and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`warm:${botId}`}, 0)`,
        );
        await expect.poll(() => errors.length).toBeGreaterThan(0);
      } finally {
        held.release();
      }

      expect(await warm).toEqual({ warmed: true });
      expect(await warmLockHeld(botId)).toBe(false);
      // The call is billed, so its row goes through the pool instead.
      expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
    },
  );

  it(
    "gives up on a Provider that never answers, freeing the Bot's lock and its connection",
    { timeout },
    async () => {
      const errors: unknown[][] = [];
      const { fake, user, client, botId } = await botWith(
        [round(), warmRound()],
        "anthropic:claude-sonnet-5-5",
        { logger: { error: (...args: unknown[]) => errors.push(args) } },
      );
      await send(client, botId, "hi");
      await ageCalls(user.id, 56);
      const play = fake.adapter.chatStream;
      // A Provider that stalls and ignores the abort.
      fake.adapter.chatStream = (() => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      })) as unknown as typeof fake.adapter.chatStream;
      const real = AbortSignal.timeout.bind(AbortSignal);
      const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(300));
      const pool = (getTestDb() as unknown as { $client: pg.Pool }).$client;

      try {
        const warmed = await Promise.race([
          client.bots.warm({ botId }),
          new Promise((resolve) => setTimeout(() => resolve("stuck"), 5_000)),
        ]);
        expect(warmed).toEqual({ warmed: false, skipped: "unavailable" });
      } finally {
        spy.mockRestore();
      }
      expect(await usageKinds(user.id)).toEqual(["turn"]);
      expect(await warmLockHeld(botId)).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      // Every connection the pool opened is back in it.
      expect(pool.idleCount).toBe(pool.totalCount);
      expect(pool.totalCount).toBeGreaterThan(0);

      fake.adapter.chatStream = play;
      expect(await client.bots.warm({ botId })).toEqual({ warmed: true });
    },
  );

  it("lets the next warm run after a failed call, which records nothing", { timeout }, async () => {
    const { fake, user, client, botId } = await botWith(
      [round(), warmRound()],
      "anthropic:claude-sonnet-5-5",
    );
    await send(client, botId, "hi");
    await ageCalls(user.id, 56);
    const play = fake.adapter.chatStream;
    fake.adapter.chatStream = () => {
      throw new Error("the Provider is down");
    };

    expect(await client.bots.warm({ botId })).toEqual({ warmed: false, skipped: "unavailable" });
    expect(await usageKinds(user.id)).toEqual(["turn"]);
    expect(await warmLockHeld(botId)).toBe(false);

    fake.adapter.chatStream = play;
    expect(await client.bots.warm({ botId })).toEqual({ warmed: true });
    expect(await usageKinds(user.id)).toEqual(["turn", "warm"]);
  });
});
