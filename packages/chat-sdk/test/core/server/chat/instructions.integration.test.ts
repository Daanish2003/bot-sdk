import { conversation, message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import { citationPrompt } from "../../../../core/shared/chat/citations";
import type { ChatCommand } from "../../../../core/shared/chat/command";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const instructions = "Answer briefly. Use British spelling.";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

/**
 * A signed-in user with Anthropic and Tavily keys, a titled Conversation and scripted adapters:
 * one per `adapterFor` call, in order (the reply's, then the title call's when there is one).
 */
async function setup({
  scripts = [[round(text("Sure."))]],
  manual = false,
  titled = true,
}: { scripts?: Rounds[]; manual?: boolean; titled?: boolean } = {}) {
  const user = await insertUser();
  const fakes = scripts.map((rounds) => createFakeAdapter({ rounds, manual }));
  const adapters = fakes.map((fake) => fake.adapter);
  const deps = createTestDeps({
    adapterFor: () => {
      const next = adapters.shift();
      if (!next) throw new Error("No more fake adapters");
      return next;
    },
    searchClient: createFakeSearchClient({ results: [] }),
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await saveCredentials(deps, user.id, {
    service: "tavily",
    fields: { apiKey: "tvly-test-key" },
    hint: "…-key",
    verified: true,
  });
  const conv = await insertConversation(user, titled ? { title: "Instructions" } : {});
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
            text: "What's new?",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fakes, conv, send };
}

async function saveInstructions(deps: AppDeps, user: TestUser, value: string | null) {
  await chatRpc({ user, deps }).settings.setInstructions({ instructions: value });
}

async function messagesOf(deps: AppDeps, conversationId: string) {
  return deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt), asc(message.role));
}

describe("user Instructions in a Run", () => {
  it("are sent as a system prompt after the SDK's own prompts when web search is on", async () => {
    const { deps, user, fakes, send } = await setup();
    await saveInstructions(deps, user, instructions);

    await (await send({ webSearch: true })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([citationPrompt, instructions]);
  });

  it("are sent without web search, where the SDK has no prompt of its own", async () => {
    const { deps, user, fakes, send } = await setup();
    await saveInstructions(deps, user, instructions);

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([instructions]);
  });

  it("are left out when the user has none", async () => {
    const { deps, user, fakes, send } = await setup();
    await saveInstructions(deps, user, "   ");

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts ?? []).toEqual([]);
  });

  it("are not sent to the Title Model's call", async () => {
    const { deps, user, fakes, conv, send } = await setup({
      titled: false,
      scripts: [[round(text("Sure."))], [round(text("A title"))]],
    });
    await saveInstructions(deps, user, instructions);

    await (await send({ webSearch: false })).text();

    await vi.waitFor(async () => {
      const [row] = await deps.db
        .select({ title: conversation.title })
        .from(conversation)
        .where(eq(conversation.id, conv.id));
      expect(row?.title).toBe("A title");
    });
    // The title call has its own prompt; the user's Instructions are not in it.
    expect(JSON.stringify(fakes[1]!.calls[0]!.systemPrompts)).not.toContain(instructions);
  });

  it("keep the Run that is streaming on the Instructions it started with", async () => {
    const { deps, user, fakes, send } = await setup({ manual: true });
    await saveInstructions(deps, user, instructions);

    const response = send({ webSearch: false });
    await vi.waitFor(() => expect(fakes[0]!.calls).toHaveLength(1));
    await saveInstructions(deps, user, "Reply in French.");
    await fakes[0]!.releaseAll();
    await (await response).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([instructions]);
  });

  it("apply to the next Run and to a regenerate", async () => {
    const { deps, user, fakes, conv, send } = await setup({
      scripts: [[round(text("First."))], [round(text("Second."))]],
    });
    await saveInstructions(deps, user, instructions);
    await (await send({ webSearch: false })).text();

    await saveInstructions(deps, user, "Reply in French.");
    const [question] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "user");
    await (await send({ text: undefined, parentId: question!.id, webSearch: false })).text();

    expect(fakes[1]!.calls[0]!.systemPrompts).toEqual(["Reply in French."]);
  });
});
