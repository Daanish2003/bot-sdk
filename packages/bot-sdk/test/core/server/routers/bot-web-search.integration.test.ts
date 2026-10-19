import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botHelper, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { webSearchUnavailableError } from "../../../../plugins/bot/server/web-search";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { quotaLookup } from "../../../../plugins/models/server/quota";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const hostModel = "anthropic:claude-sonnet-5-5";
const silent = { error: () => {} };

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/**
 * A Tavily that answers every search with one result, and keeps the requests it got. `onSearch`
 * runs while a search is in flight.
 */
function fakeTavily(onSearch?: () => Promise<void>) {
  const requests: { authorization: string | null; query: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      query: JSON.parse(String(init?.body)).query,
    });
    await onSearch?.();
    return Response.json({
      results: [{ title: "Delhi weather", url: "https://wx.example/delhi", content: "31 degrees" }],
    });
  };
  return { fetch, requests };
}

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

const search = (query: string) => toolCall({ name: "web_search", input: { query } });
const sends = (input: { text: string; endTurn: boolean }) =>
  toolCall({ name: "send_to_user", input });
const startHelper = (task: string) =>
  toolCall({ name: "start_helper", input: { type: "general", task } });

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

/**
 * A user and a Bot over an SDK whose fetch is a fake Tavily. `own` saves the user's Tavily key;
 * `host` gives the Host a Tavily key at $0.01 a search and the Bot a Host Model.
 */
async function botWith(
  rounds: Rounds,
  {
    own = false,
    host = false,
    withComputer = false,
    helperRounds = [],
    onSearch,
    ...overrides
  }: {
    own?: boolean;
    host?: boolean;
    withComputer?: boolean;
    helperRounds?: Rounds;
    onSearch?: () => Promise<void>;
  } & Pick<TestDepsOverrides, "getQuota"> = {},
) {
  const tavily = fakeTavily(onSearch);
  const turnFake = createFakeAdapter({ rounds });
  const helperFake = createFakeAdapter({ rounds: helperRounds });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      (options.systemPrompts ?? []).some((prompt) => String(prompt).startsWith("You are a Helper"))
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as typeof turnFake.adapter;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    plugins: withComputer
      ? [bot(), computer({ provider: fakeComputerProvider({}).provider })]
      : [bot()],
    jobs,
    adapterFor: () => adapter,
    fetch: tavily.fetch,
    ...(host
      ? {
          hostProviders,
          hostTools: [
            { tool: "tavily", credentials: { apiKey: "tvly-host" }, pricePerSearchUsd: 0.01 },
          ],
        }
      : {}),
    ...overrides,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!host) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  if (own) {
    await saveCredentials(deps, user.id, {
      service: "tavily",
      fields: { apiKey: "tvly-own" },
      hint: "…-own",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({ name: "Ada", model: host ? hostModel : model });
  return { turnFake, helperFake, tavily, client, user, botId: created.id };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, message: string) {
  for await (const _ of await client.bot.send({ botId, id: uuidv7(), text: message }));
}

const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
const lastToolResult = (call: TextOptions | undefined) =>
  JSON.parse(String(inputOf(call).findLast((entry) => entry.role === "tool")?.content));
const usageOf = (userId: string) =>
  getTestDb().select().from(usage).where(eq(usage.userId, userId)).orderBy(asc(usage.createdAt));

const done = sends({ text: "ok", endTurn: true });

describe("the Bot's web search", () => {
  it("searches with the user's own Tavily key, with or without a Computer", async () => {
    for (const withComputer of [false, true]) {
      const { client, botId, turnFake, tavily } = await botWith(
        [round(search("weather in Delhi")), round(done)],
        { own: true, withComputer },
      );

      await send(client, botId, "weather?");

      expect(tavily.requests).toEqual([
        { authorization: "Bearer tvly-own", query: "weather in Delhi" },
      ]);
      expect(lastToolResult(turnFake.calls[1])).toEqual({
        results: [
          { title: "Delhi weather", url: "https://wx.example/delhi", snippet: "31 degrees" },
        ],
      });
      expect(turnFake.calls[0]?.tools?.map((tool) => tool.name)).toContain("web_search");
    }
  });

  it("records a Host-paid search as web_search usage", async () => {
    const { client, botId, user } = await botWith([round(search("news")), round(done)], {
      host: true,
    });

    await send(client, botId, "news?");

    const rows = (await usageOf(user.id)).filter((row) => row.kind === "web_search");
    expect(rows).toMatchObject([{ model: "tavily", costMicros: 10_000 }]);
  });

  it("searches with no transaction open, and records the search once", async () => {
    const openDuringSearch: (number | undefined)[] = [];
    const { client, botId, user } = await botWith([round(search("news")), round(done)], {
      host: true,
      onSearch: async () => {
        const { rows } = await getTestDb().execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and state = 'idle in transaction'`,
        );
        openDuringSearch.push(rows[0]?.n);
      },
    });

    await send(client, botId, "news?");

    expect(openDuringSearch).toEqual([0]);
    const rows = (await usageOf(user.id)).filter((row) => row.kind === "web_search");
    expect(rows).toHaveLength(1);
  });

  it("does not search once a search has spent the Quota", async () => {
    const { client, botId, turnFake, tavily } = await botWith(
      [round(search("news")), round(search("more news")), round(done)],
      // 200 micros a day: the first search (10,000) spends it.
      { host: true, getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }) },
    );

    await send(client, botId, "news?");

    expect(tavily.requests.map((request) => request.query)).toEqual(["news"]);
    expect(lastToolResult(turnFake.calls[2])).toMatchObject({ reason: "quota_exceeded" });
  });

  it("says search is not set up with neither a Tool credential nor a Host key", async () => {
    const { client, botId, turnFake, tavily } = await botWith([round(search("news")), round(done)]);

    await send(client, botId, "news?");

    expect(tavily.requests).toEqual([]);
    expect(lastToolResult(turnFake.calls[1])).toEqual({ error: webSearchUnavailableError });
    expect(webSearchUnavailableError).toBe(
      "Web search isn't set up. Add a Tavily key in Settings, or ask the user.",
    );
  });

  it("does not claim the Bot can't look up live data", async () => {
    const { client, botId, turnFake } = await botWith([round()]);

    await send(client, botId, "hi");

    const prompt = JSON.stringify(turnFake.calls[0]?.systemPrompts);
    expect(prompt).not.toContain("look up live data");
    expect(prompt).toContain("web_search");
  });
});

describe("a General Helper's web search", () => {
  it("searches and is metered like the Bot", async () => {
    const { client, botId, user, helperFake, tavily } = await botWith(
      [round(startHelper("Find the weather in Delhi."), done), round()],
      {
        host: true,
        withComputer: true,
        helperRounds: [round(search("weather in Delhi")), round(text("31 degrees."))],
      },
    );

    await send(client, botId, "weather?");
    await expect
      .poll(async () => {
        const [helper] = await getTestDb()
          .select()
          .from(botHelper)
          .where(eq(botHelper.botId, botId));
        return helper?.status;
      })
      .toBe("complete");

    expect(helperFake.calls[0]?.tools?.map((tool) => tool.name)).toContain("web_search");
    expect(tavily.requests).toEqual([
      { authorization: "Bearer tvly-host", query: "weather in Delhi" },
    ]);
    const rows = (await usageOf(user.id)).filter((row) => row.kind === "web_search");
    expect(rows).toMatchObject([{ costMicros: 10_000 }]);
  });
});
