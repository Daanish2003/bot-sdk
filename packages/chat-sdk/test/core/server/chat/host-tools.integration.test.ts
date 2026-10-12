import { conversation } from "../../../../core/server/db/schema/chat";
import { usage as usageRows } from "../../../../core/server/db/schema/usage";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, HostProvider, HostTool } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall, withUsage } from "../../../support/fake-adapter";
import { createFakeSearchClient, type FakeSearchClient } from "../../../support/fake-search-client";
import { insertUser, type TestUser } from "../../../support/users";
import { sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const hostTavilyKey = { apiKey: "tvly-host-key" };
const ownTavilyKey = { apiKey: "tvly-own-key" };
const pricePerSearchUsd = 0.008;

const hostTools: HostTool[] = [{ tool: "tavily", credentials: hostTavilyKey, pricePerSearchUsd }];
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-key" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        tools: true,
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];

const searchCall = (id: string, query: string) =>
  toolCall({ id, name: "web_search", input: { query } });

/** A reply that searches once, then answers. */
const searchingReply = [
  round(text("Let me look."), searchCall("call-1", "tanstack ai")),
  round(text("Done.")),
];

/**
 * A signed-in user and scripted adapters. Each `adapterFor` call takes the next script: the
 * reply's, then (for an untitled Conversation) the title call's.
 */
async function setup({
  user,
  scripts,
  titled = true,
  deps: overrides = {},
  searchClient = createFakeSearchClient({ results: [] }),
}: {
  user: TestUser;
  scripts: Parameters<typeof createFakeAdapter>[0]["rounds"][];
  titled?: boolean;
  deps?: TestDepsOverrides;
  searchClient?: FakeSearchClient;
}) {
  const fakes = scripts.map((rounds) => createFakeAdapter({ rounds }));
  const pending = [...fakes];
  const deps: AppDeps = createTestDeps({
    adapterFor: () => {
      const next = pending.shift();
      if (!next) throw new Error("No more fake adapters");
      return next.adapter;
    },
    searchClient,
    ...overrides,
  });
  const conv = await insertConversation(user, {
    model: anthropicModel,
    ...(titled ? { title: "Test Conversation" } : {}),
  });
  const send = (webSearch: boolean) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What's new in TanStack AI?",
            attachmentIds: [],
            model: anthropicModel,
            webSearch,
          },
        }),
      }),
      user,
      deps,
    );
  return { deps, conv, fakes, send };
}

/** The rows of `chat.usage` for `userId`, oldest first. */
function usageOf(userId: string) {
  return getTestDb()
    .select({
      kind: usageRows.kind,
      model: usageRows.model,
      costMicros: usageRows.costMicros,
      estimated: usageRows.estimated,
      inputTokens: usageRows.inputTokens,
      outputTokens: usageRows.outputTokens,
    })
    .from(usageRows)
    .where(eq(usageRows.userId, userId))
    .orderBy(asc(usageRows.createdAt));
}

async function titleOf(conversationId: string) {
  const [row] = await getTestDb()
    .select({ title: conversation.title })
    .from(conversation)
    .where(eq(conversation.id, conversationId));
  return row?.title;
}

describe("Host Tool credentials for web search", () => {
  it("searches on the Host's Tavily key when the user has no Tool credential, and records the fixed price", async () => {
    const user = await insertUser();
    const searchClient = createFakeSearchClient({ results: [] });
    // The reply runs on the user's own Anthropic key, so only the search is on the Host's bill.
    const { deps, fakes, send } = await setup({
      user,
      searchClient,
      scripts: [searchingReply],
      deps: { hostTools },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send(true)).text();

    expect(fakes[0]?.calls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
      "fetch_url",
    ]);
    expect(searchClient.calls).toEqual([{ query: "tanstack ai", credentials: hostTavilyKey }]);
    expect(await usageOf(user.id)).toEqual([
      {
        kind: "web_search",
        model: "tavily",
        costMicros: 8_000,
        estimated: false,
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);
  });

  it("searches on the user's own Tavily key over the Host's, and records no usage", async () => {
    const user = await insertUser();
    const searchClient = createFakeSearchClient({ results: [] });
    const { deps, send } = await setup({
      user,
      searchClient,
      scripts: [searchingReply],
      deps: { hostTools },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });
    await saveCredentials(deps, user.id, {
      service: "tavily",
      fields: ownTavilyKey,
      hint: "…-key",
      verified: true,
    });

    await (await send(true)).text();

    expect(searchClient.calls).toEqual([{ query: "tanstack ai", credentials: ownTavilyKey }]);
    expect(await usageOf(user.id)).toEqual([]);
  });

  it("records no web_search usage when the Host's search fails", async () => {
    const user = await insertUser();
    const searchClient = createFakeSearchClient({ error: "failed" });
    const { deps, send } = await setup({
      user,
      searchClient,
      scripts: [searchingReply],
      deps: { hostTools },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send(true)).text();

    expect(searchClient.calls).toHaveLength(1);
    expect(await usageOf(user.id)).toEqual([]);
  });
});

describe("Host credentials for automatic titles", () => {
  const titleUsage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };

  it("writes a title usage row when the title is generated on Host credentials", async () => {
    const user = await insertUser();
    const { conv, send } = await setup({
      user,
      titled: false,
      scripts: [
        [round(text("Paris is the capital."))],
        [withUsage(round(text("Capital of France")), titleUsage)],
      ],
      deps: { hostProviders },
    });

    await (await send(false)).text();

    await vi.waitFor(async () => expect(await titleOf(conv.id)).toBe("Capital of France"));
    await vi.waitFor(async () =>
      expect((await usageOf(user.id)).map((r) => r.kind)).toEqual(["run", "title"]),
    );
    const [, title] = await usageOf(user.id);
    expect(title).toMatchObject({
      kind: "title",
      model: anthropicModel,
      // 100 input tokens at $3 per 1M, plus 10 output tokens at $15 per 1M.
      costMicros: 450,
      estimated: false,
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it("writes no title usage row when the title is generated on the user's own key", async () => {
    const user = await insertUser();
    const { deps, conv, send } = await setup({
      user,
      titled: false,
      scripts: [
        [round(text("Paris is the capital."))],
        [withUsage(round(text("Capital of France")), titleUsage)],
      ],
      deps: { hostProviders },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send(false)).text();

    await vi.waitFor(async () => expect(await titleOf(conv.id)).toBe("Capital of France"));
    expect(await usageOf(user.id)).toEqual([]);
  });
});
