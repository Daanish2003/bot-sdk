import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { EventType } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import {
  createFakeAdapter,
  round,
  runError,
  text,
  toolCall,
  withUsage,
} from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { insertUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const openaiModel = "openai:gpt-5.6";

const result = { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" };

/** A signed-in user with Anthropic and OpenAI credentials and a scripted adapter. */
async function setup({
  rounds,
  manual = false,
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  manual?: boolean;
}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds, manual });
  const deps = createTestDeps({
    adapterFor: () => fake.adapter,
    searchClient: createFakeSearchClient({ results: [result] }),
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "sk-openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  await saveCredentials(deps, user.id, {
    service: "tavily",
    fields: { apiKey: "tvly-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it.
  const conv = await insertConversation(user, { title: "Usage" });
  const send = (model = anthropicModel, text = "Hi") =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text,
            attachmentIds: [],
            model,
            // Offers `web_search`, so a scripted tool call has a tool to run.
            webSearch: true,
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

describe("the Run's usage", () => {
  it("stores the sum of every model iteration's usage on the assistant Message", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        withUsage(round(toolCall({ id: "call-1", name: "web_search", input: { query: "x" } })), {
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
        }),
        withUsage(round(text("Done")), {
          promptTokens: 150,
          completionTokens: 5,
          totalTokens: 155,
        }),
      ],
    });

    await (await send()).text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      input: 250,
      output: 15,
      reasoning: 0,
      cached: 0,
      estimated: false,
    });
  });

  it("adds the cached and cache-write tokens back to input for Anthropic, which reports input without them", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        withUsage(round(text("Done")), {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          promptTokensDetails: { cachedTokens: 30, cacheWriteTokens: 5 },
        }),
      ],
    });

    await (await send(anthropicModel)).text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      input: 45,
      output: 4,
      reasoning: 0,
      cached: 30,
      estimated: false,
    });
  });

  it("stores the usage of the other Providers as reported, cached tokens already in input", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        withUsage(round(text("Done")), {
          promptTokens: 40,
          completionTokens: 9,
          totalTokens: 49,
          promptTokensDetails: { cachedTokens: 30 },
          completionTokensDetails: { reasoningTokens: 6 },
        }),
      ],
    });

    await (await send(openaiModel)).text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      input: 40,
      output: 9,
      reasoning: 6,
      cached: 30,
      estimated: false,
    });
  });

  it("stores an estimate, flagged estimated, when a stopped Run reports no usage", async () => {
    const { user, deps, conv, fake, send } = await setup({
      rounds: [round(text("Partial reply"))],
      manual: true,
    });
    const response = await send();
    const reply = await replyOf(deps, conv.id);
    await fake.release(3);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await response.text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      // "Hi" is 2 characters, "Partial reply" is 13: each a quarter of a token, rounded up.
      input: 1,
      output: 4,
      reasoning: 0,
      cached: 0,
      estimated: true,
    });
  });

  it("stores an estimate, flagged estimated, when a failed Run reports no usage", async () => {
    const { deps, conv, send } = await setup({
      rounds: [round(text("Partial"), runError("Overloaded"))],
    });

    await (await send()).text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      input: 1,
      output: 2,
      reasoning: 0,
      cached: 0,
      estimated: true,
    });
  });

  it("returns the usage on the Conversation read, null on the user's Message", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [
        withUsage(round(text("Done")), { promptTokens: 7, completionTokens: 3, totalTokens: 10 }),
      ],
    });
    await (await send(openaiModel)).text();

    const read = await chatRpc({ user, deps }).conversation.get({ id: conv.id });

    expect(read.messages.map((row) => row.usage)).toEqual([
      null,
      { input: 7, output: 3, reasoning: 0, cached: 0, estimated: false },
    ]);
  });

  it("stores usage reported in the AG-UI array form as reported, not as an estimate", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        round(text("Done")).map((chunk) =>
          chunk.type === EventType.RUN_FINISHED
            ? { ...chunk, usage: [{ inputTokens: 12, outputTokens: 3, totalTokens: 15 }] }
            : chunk,
        ),
      ],
    });

    await (await send(openaiModel)).text();

    expect((await replyOf(deps, conv.id)).usage).toEqual({
      input: 12,
      output: 3,
      reasoning: 0,
      cached: 0,
      estimated: false,
    });
  });

  it("leaves usage out of a Shared link snapshot", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [
        withUsage(round(text("Done")), { promptTokens: 7, completionTokens: 3, totalTokens: 10 }),
      ],
    });
    await (await send(openaiModel)).text();
    const link = await chatRpc({ user, deps }).share.upsert({ conversationId: conv.id });

    const shared = await chatRpc({ deps }).share.get({ token: link.token });

    expect(shared?.messages).toHaveLength(2);
    for (const sharedMessage of shared?.messages ?? []) {
      expect(sharedMessage).not.toHaveProperty("usage");
    }
  });
});
