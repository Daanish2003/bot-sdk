import { storedParts, type ToolCallPart } from "../../../../core/shared/message-parts";
import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createChat } from "../../../../core/server/create-chat";
import { createGuardedFetch } from "../../../../core/server/lib/guarded-fetch";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { fetchLimitError } from "../../../../core/shared/chat/fetch-url";
import { citationPrompt } from "../../../../core/shared/chat/citations";

const anthropicModel = "anthropic:claude-sonnet-5-5";

type ScriptedPage =
  | { body: string | Uint8Array<ArrayBuffer>; type?: string; status?: number }
  | "hang";

/**
 * A fetch that never reaches the network: each URL gets a scripted page, or hangs until its signal
 * aborts. Every URL it is asked for is recorded.
 */
function scriptedFetch(pages: Record<string, ScriptedPage>) {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const page = pages[url];
    if (page === undefined) throw new Error(`No scripted page for ${url}`);
    if (page === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { "content-type": page.type ?? "text/plain" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const fetchCall = (id: string, url: string) => toolCall({ id, name: "fetch_url", input: { url } });

const fetched = (fields: Partial<ToolCallPart>): ToolCallPart => ({
  type: "tool_call",
  toolCallId: "call-1",
  name: "fetch_url",
  source: "builtin",
  args: { url: "https://example.com/page" },
  state: "done",
  result: { url: "https://example.com/page", title: "Page", content: "Hello" },
  ...fields,
});

/** A signed-in user with Anthropic credentials, and a Tavily key unless `tavily: false`. */
async function setup({
  rounds,
  pages = {},
  tavily = true,
  deps: overrides = {},
  fetch,
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  pages?: Record<string, ScriptedPage>;
  tavily?: boolean;
  deps?: TestDepsOverrides;
  /** Replaces the scripted fetch, for a test that wants the real guard. */
  fetch?: typeof globalThis.fetch;
}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const scripted = scriptedFetch(pages);
  const deps = createTestDeps({
    adapterFor: () => fake.adapter,
    fetch: fetch ?? scripted.fetch,
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  if (tavily) {
    await saveCredentials(deps, user.id, {
      service: "tavily",
      fields: { apiKey: "tvly-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Fetch" });
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
            text: "Summarise https://example.com/page",
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
  return { user, deps, fake, conv, send, requests: scripted.requests };
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

/** The output the Model read for the call `id`, parsed. */
function modelReadOf(fake: ReturnType<typeof createFakeAdapter>, id: string, round = 1) {
  const reply = fake.calls[round]!.messages.find(
    (candidate) => candidate.role === "tool" && candidate.toolCallId === id,
  );
  return JSON.parse(String(reply?.content));
}

const url = "https://example.com/page";

describe("the fetch_url tool", () => {
  it.each([
    [
      "HTML",
      "text/html; charset=utf-8",
      '<html><head><title>Notes</title><style>p{color:red}</style></head><body><script>var x = 1</script><p>Hello <a href="https://other.test/">world</a></p></body></html>',
      { title: "Notes", content: "Hello world" },
    ],
    ["plain text", "text/plain", "Just words.", { title: "example.com", content: "Just words." }],
    [
      "Markdown",
      "text/markdown",
      "# Heading\n\nBody.",
      { title: "example.com", content: "# Heading\n\nBody." },
    ],
    ["JSON", "application/json", '{"ok":true}', { title: "example.com", content: '{"ok":true}' }],
  ])(
    "reads %s as text for the Model and stores it as a Source",
    async (_kind, type, body, expected) => {
      const { deps, fake, conv, send } = await setup({
        pages: { [url]: { body, type } },
        rounds: [round(fetchCall("call-1", url)), round(text("Summary."))],
      });

      await (await send()).text();

      expect(modelReadOf(fake, "call-1")).toEqual({ url, ...expected });
      expect(await replyOf(deps, conv.id)).toMatchObject({
        status: "complete",
        parts: storedParts([
          fetched({ result: { url, ...expected } }),
          { type: "text", text: "Summary." },
        ]),
      });
    },
  );

  it("refuses a PDF or other binary as a failed call, and the reply continues", async () => {
    const { deps, fake, conv, send } = await setup({
      pages: { [url]: { body: new Uint8Array([37, 80, 68, 70]), type: "application/pdf" } },
      rounds: [round(fetchCall("call-1", url)), round(text("I can't read PDFs."))],
    });

    await (await send()).text();

    const error = {
      error: "Only HTML, plain text, Markdown and JSON pages can be read",
      reason: "unsupported",
    };
    expect(modelReadOf(fake, "call-1")).toEqual(error);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        fetched({ state: "error", result: error }),
        { type: "text", text: "I can't read PDFs." },
      ]),
    });
  });

  it("refuses a body over 2 MB", async () => {
    const { fake, send } = await setup({
      pages: { [url]: { body: new Uint8Array(2 * 1024 * 1024 + 1) } },
      rounds: [round(fetchCall("call-1", url)), round(text("Too big."))],
    });

    await (await send()).text();

    expect(modelReadOf(fake, "call-1")).toEqual({
      error: "The page is larger than 2 MB",
      reason: "too_large",
    });
  });

  it("cuts text over the character cap and says so", async () => {
    const { fake, send } = await setup({
      pages: { [url]: { body: "a".repeat(25_000) } },
      rounds: [round(fetchCall("call-1", url)), round(text("Long."))],
    });

    await (await send()).text();

    const page = modelReadOf(fake, "call-1");
    expect(page.content).toHaveLength(20_000);
    expect(page.truncated).toBe(true);
  });

  it("fails a page slower than the timeout, and the reply completes", async () => {
    const { deps, fake, conv, send } = await setup({
      pages: { [url]: "hang" },
      deps: { limits: { fetchTimeoutMs: 50 } },
      rounds: [round(fetchCall("call-1", url)), round(text("It was slow."))],
    });

    await (await send()).text();

    expect(modelReadOf(fake, "call-1")).toEqual({
      error: "The page took too long to load",
      reason: "timed_out",
    });
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        fetched({
          state: "error",
          result: { error: "The page took too long to load", reason: "timed_out" },
        }),
        { type: "text", text: "It was slow." },
      ]),
    });
  });

  it("refuses a page at a non-public address through the guard, and the reply continues", async () => {
    const guarded = createGuardedFetch({
      schemes: "http-and-https",
      resolve: async () => ["10.0.0.5"],
    });
    const { fake, requests, send } = await setup({
      fetch: guarded,
      rounds: [round(fetchCall("call-1", "http://internal.example/")), round(text("Blocked."))],
    });

    await (await send()).text();

    expect(requests).toEqual([]);
    expect(modelReadOf(fake, "call-1")).toEqual({
      error: "The address is not a public address",
      reason: "blocked",
    });
  });

  it("runs five fetches per reply; a sixth gets an error and fetches nothing", async () => {
    const urls = [1, 2, 3, 4, 5, 6].map((n) => `https://example.com/${n}`);
    const pages = Object.fromEntries(urls.map((u) => [u, { body: `Page ${u}` }]));
    const { fake, requests, deps, conv, send } = await setup({
      pages,
      rounds: [round(...urls.map((u, i) => fetchCall(`call-${i + 1}`, u))), round(text("Done."))],
    });

    await (await send()).text();

    expect(requests).toEqual(urls.slice(0, 5));
    expect(modelReadOf(fake, "call-6")).toEqual({ error: fetchLimitError });
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
  });

  it("is offered with Web on and no Tavily key, and web_search is not", async () => {
    const { fake, send } = await setup({
      tavily: false,
      pages: { [url]: { body: "Hi." } },
      rounds: [round(text("Hi."))],
    });

    await (await send()).text();

    expect(offeredTools(fake)).toEqual(["fetch_url"]);
    expect(fake.calls[0]!.systemPrompts).toEqual([citationPrompt]);
  });

  it("is not offered when Web is off", async () => {
    const { fake, send } = await setup({ rounds: [round(text("Hi."))] });

    await (await send({ webSearch: false })).text();

    expect(offeredTools(fake)).toEqual([]);
  });

  it("closes a fetch still running when the reply is stopped as cancelled", async () => {
    const { user, deps, conv, send } = await setup({
      pages: { [url]: "hang" },
      rounds: [round(fetchCall("call-1", url)), round(text("Never."))],
    });
    const response = await send();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });

    await response.text();
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "stopped",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "fetch_url",
          source: "builtin",
          args: { url },
          state: "cancelled",
        },
      ]),
    });
  });

  it("replays an earlier fetch to the Model as a tool call with its result", async () => {
    const { fake, conv, send } = await setup({ rounds: [round(text("Sure."))] });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const answer = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([fetched({}), { type: "text", text: "It says hello." }]),
    });

    await (await send({ parentId: answer.id, text: "More?" })).text();

    expect(fake.calls[0]!.messages).toMatchObject([
      { role: "user", content: "Hi" },
      { role: "assistant", toolCalls: [{ id: "call-1", function: { name: "fetch_url" } }] },
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ url, title: "Page", content: "Hello" }),
      },
      { role: "assistant", content: "It says hello." },
      { role: "user", content: "More?" },
    ]);
  });
});

describe("the Host's tools", () => {
  it("can't take the name of a built-in tool", () => {
    const tool = (name: string) => ({ name }) as never;
    const options = {
      databaseUrl: "postgresql://unused",
      getUser: async () => null,
      keyEncryptionSecrets: ["secret"],
      basePath: "/api/chat",
    };

    expect(() => createChat({ ...options, tools: [tool("fetch_url")] })).toThrow(
      `A Host tool can't be named "fetch_url"`,
    );
    expect(() => createChat({ ...options, tools: [tool("web_search")] })).toThrow(
      `A Host tool can't be named "web_search"`,
    );
  });
});
