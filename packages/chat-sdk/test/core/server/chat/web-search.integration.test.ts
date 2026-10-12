import { storedParts, type WebSearchPart } from "../../../../core/shared/message-parts";
import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, SearchClient } from "../../../../core/server/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { insertUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import { citationPrompt } from "../../../../core/shared/chat/citations";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { curatedModels } from "../../../../core/shared/chat/models";
import { reapStaleRuns } from "../../../../core/server/chat/run";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const tavilyKey = { apiKey: "tvly-test-key" };

const result = (n: number) => ({
  title: `Result ${n}`,
  url: `https://example.com/${n}`,
  snippet: `Snippet ${n}`,
});

const searchCall = (id: string, query: string) =>
  toolCall({ id, name: "web_search", input: { query } });

const search = (fields: Partial<WebSearchPart>): WebSearchPart => ({
  type: "web_search",
  toolCallId: "call-1",
  query: "tanstack ai",
  state: "done",
  results: [result(1)],
  ...fields,
});

/** A signed-in user with Anthropic credentials (and a Tavily key unless `tavily: false`). */
async function setup({
  rounds,
  searchClient = createFakeSearchClient({ results: [result(1)] }),
  tavily = true,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  searchClient?: SearchClient;
  tavily?: boolean;
  deps?: TestDepsOverrides;
}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const deps = createTestDeps({ adapterFor: () => fake.adapter, searchClient, ...overrides });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  if (tavily) {
    await saveCredentials(deps, user.id, {
      service: "tavily",
      fields: tavilyKey,
      hint: "…-key",
      verified: true,
    });
  }
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Web search" });
  const send = (command: Partial<ChatCommand> = {}) =>
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
            webSearch: true,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fake, conv, send };
}

async function replyOf(deps: AppDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.find((row) => row.role === "assistant")!;
}

const offeredTools = (fake: ReturnType<typeof createFakeAdapter>) =>
  (fake.calls[0]?.tools ?? []).map((tool) => tool.name);

/** A search client whose searches never finish on their own; they fail when aborted. */
const hangingSearchClient: SearchClient = {
  search: (_query, _credentials, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
};

describe("the web_search tool", () => {
  it("searches mid-reply and stores the search between the text around it", async () => {
    const searchClient = createFakeSearchClient({ results: [result(1), result(2)] });
    const { deps, fake, conv, send } = await setup({
      searchClient,
      rounds: [
        round(text("Let me look."), searchCall("call-1", "tanstack ai")),
        round(text("Lazy tools.")),
      ],
    });

    const body = await (await send()).text();

    expect(offeredTools(fake)).toEqual(["web_search", "fetch_url"]);
    expect(searchClient.calls).toEqual([{ query: "tanstack ai", credentials: tavilyKey }]);
    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({
      status: "complete",
      searchText: "Let me look.\nLazy tools.",
      parts: storedParts([
        { type: "text", text: "Let me look." },
        search({ results: [result(1), result(2)] }),
        { type: "text", text: "Lazy tools." },
      ]),
    });
    // The Model read the results, and the client streamed them.
    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ results: [result(1), result(2)] }),
    });
    expect(body).toContain('"type":"TOOL_CALL_RESULT"');
  });

  it("allows 3 searches per reply; the 4th call gets an error and searches nothing", async () => {
    const searchClient = createFakeSearchClient({ results: [result(1)] });
    const { deps, fake, conv, send } = await setup({
      searchClient,
      rounds: [
        round(searchCall("call-1", "one"), searchCall("call-2", "two")),
        round(searchCall("call-3", "three"), searchCall("call-4", "four")),
        round(text("Done.")),
      ],
    });

    await (await send()).text();

    expect(searchClient.calls.map((call) => call.query)).toEqual(["one", "two", "three"]);
    expect(fake.calls[2]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-4",
      content: JSON.stringify({ error: "search limit reached" }),
    });
    const reply = await replyOf(deps, conv.id);
    expect(reply.status).toBe("complete");
    expect(reply.parts).toEqual(
      storedParts([
        search({ toolCallId: "call-1", query: "one" }),
        search({ toolCallId: "call-2", query: "two" }),
        search({ toolCallId: "call-3", query: "three" }),
        { type: "text", text: "Done." },
      ]),
    );
  });

  it("stores a failed search as an error state and the reply continues", async () => {
    const { deps, fake, conv, send } = await setup({
      searchClient: createFakeSearchClient({ error: "invalid_key" }),
      rounds: [round(searchCall("call-1", "tanstack ai")), round(text("I couldn't search."))],
    });

    await (await send()).text();

    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({ error: "Tavily rejected the API key", reason: "invalid_key" }),
    });
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      error: null,
      parts: storedParts([
        search({ state: "error", results: [], errorReason: "invalid_key" }),
        { type: "text", text: "I couldn't search." },
      ]),
    });
  });

  it("closes a search still running when the reply is stopped as cancelled", async () => {
    const { user, deps, conv, send } = await setup({
      searchClient: hangingSearchClient,
      rounds: [round(searchCall("call-1", "tanstack ai")), round(text("Never."))],
    });
    const response = await send();
    // The running search reaches the database in a snapshot.
    await expect
      .poll(async () => (await replyOf(deps, conv.id)).parts, { interval: 10 })
      .toEqual(storedParts([search({ state: "running", results: [] })]));
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });

    await response.text();
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "stopped",
      parts: storedParts([search({ state: "cancelled", results: [] })]),
    });
  });

  it("closes a search still running when the run hits the cap as cancelled", async () => {
    const { deps, conv, send } = await setup({
      searchClient: hangingSearchClient,
      rounds: [round(searchCall("call-1", "tanstack ai")), round(text("Never."))],
      deps: { limits: { snapshotIntervalMs: 20, runCapMs: 150 } },
    });

    await (await send()).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "error",
      error: "timed out",
      parts: storedParts([search({ state: "cancelled", results: [] })]),
    });
  });

  it("replays earlier searches to the Model as tool calls and results", async () => {
    const { fake, conv, send } = await setup({ rounds: [round(text("Sure."))] });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const answer = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([search({}), { type: "text", text: "Found it." }]),
    });

    await (await send({ parentId: answer.id, text: "More?" })).text();

    expect(fake.calls[0]!.messages).toMatchObject([
      { role: "user", content: "Hi" },
      { role: "assistant", toolCalls: [{ id: "call-1" }] },
      { role: "tool", toolCallId: "call-1" },
      { role: "assistant", content: "Found it." },
      { role: "user", content: "More?" },
    ]);
  });
});

describe("the web_search tool is not offered", () => {
  it("when Search is off, and earlier searches become text placeholders", async () => {
    const { fake, conv, send } = await setup({ rounds: [round(text("Sure."))] });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const answer = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([search({}), { type: "text", text: "Found it." }]),
    });

    await (await send({ parentId: answer.id, text: "More?", webSearch: false })).text();

    expect(offeredTools(fake)).toEqual([]);
    expect(fake.calls[0]!.messages[1]).toEqual({
      role: "assistant",
      content:
        '[Searched the web for "tanstack ai": Result 1 (https://example.com/1)]\n\nFound it.',
    });
  });

  it("when the user has no Tavily key: web_search is not offered, fetch_url still is", async () => {
    const { fake, send } = await setup({ tavily: false, rounds: [round(text("Sure."))] });

    const response = await send();
    await response.text();

    expect(response.status).toBe(200);
    expect(offeredTools(fake)).toEqual(["fetch_url"]);
  });

  describe("when the Model has no tool support", () => {
    const toolless = { ...curatedModels[0]!, id: "anthropic:toolless-test", tools: false };
    afterEach(() => {
      curatedModels.splice(curatedModels.indexOf(toolless), 1);
    });

    it("even if the command asks for it", async () => {
      curatedModels.push(toolless);
      const { fake, send } = await setup({ rounds: [round(text("Sure."))] });

      await (await send({ model: toolless.id })).text();

      expect(offeredTools(fake)).toEqual([]);
    });
  });
});

describe("the citation prompt", () => {
  it("asks the Model to cite with markdown links when it may search", async () => {
    const { fake, send } = await setup({ rounds: [round(text("Sure."))] });

    await (await send()).text();

    expect(fake.calls[0]!.systemPrompts).toEqual([citationPrompt]);
  });

  it("is left out when the Model can't search", async () => {
    const { fake, send } = await setup({ rounds: [round(text("Sure."))] });

    await (await send({ webSearch: false })).text();

    expect(fake.calls[0]!.systemPrompts ?? []).toEqual([]);
  });
});

describe("reapStaleRuns", () => {
  it("closes a search still running in a reaped reply as cancelled", async () => {
    const conv = await insertConversation(await insertUser());
    const now = new Date("2026-10-09T12:00:00Z");
    const row = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      status: "streaming",
      // Set explicitly: the database clock (the default) may run ahead of this process.
      heartbeatAt: new Date(now.getTime() - 60_000),
      parts: storedParts([
        { type: "text", text: "Looking." },
        search({ state: "running", results: [] }),
      ]),
    });

    await reapStaleRuns(createTestDeps(), now);

    const [after] = await createTestDeps().db.select().from(message).where(eq(message.id, row.id));
    expect(after).toMatchObject({
      status: "error",
      error: "interrupted",
      parts: storedParts([
        { type: "text", text: "Looking." },
        search({ state: "cancelled", results: [] }),
      ]),
    });
  });
});
