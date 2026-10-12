import { conversation } from "../../../../core/server/db/schema/chat";
import { getTestDb } from "../../../support/test-database";
import type { AnyTextAdapter } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { saveBackgroundModel } from "../../../../core/server/settings/store";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, runError, text } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { titleConversation } from "../../../../core/server/chat/title";

const replyModel = "anthropic:claude-sonnet-5-5";
const cheapModel = "openai:gpt-5.4-mini";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

function addAnthropicKey(userId: string) {
  return saveCredentials(createTestDeps(), userId, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
}

async function titleOfConversation(id: string) {
  const [row] = await getTestDb()
    .select({ title: conversation.title })
    .from(conversation)
    .where(eq(conversation.id, id));
  return row!.title;
}

/**
 * A signed-in user with Anthropic credentials and an empty Conversation. Each `adapterFor` call
 * takes the next scripted adapter: by default the reply's, then the title call's.
 */
async function setup({
  scripts = [[round(text("Paris is the capital."))], [round(text("Capital of France"))]],
}: { scripts?: Rounds[] } = {}) {
  const user = await insertUser();
  const fakes = scripts.map((rounds) => createFakeAdapter({ rounds }));
  const adapterCalls: Array<{ model: string; credentials: Record<string, string> }> = [];
  const adapters: AnyTextAdapter[] = fakes.map((fake) => fake.adapter);
  const deps = createTestDeps({
    adapterFor: (model, credentials) => {
      adapterCalls.push({ model, credentials });
      const next = adapters.shift();
      if (!next) throw new Error("No more fake adapters");
      return next;
    },
  });
  await addAnthropicKey(user.id);
  const conv = await insertConversation(user, { model: replyModel });
  const send = async (command: Partial<ChatCommand> = {}) => {
    const response = await sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What is the capital of France?",
            attachmentIds: [],
            model: replyModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
    await response.text();
  };
  const titleOf = () => titleOfConversation(conv.id);
  return { user, deps, conv, send, titleOf, adapterCalls, fakes, titleAdapter: fakes[1] };
}

describe("automatic titles", () => {
  it("titles a new Conversation with the Model that wrote the first reply", async () => {
    const { send, titleOf, adapterCalls, titleAdapter } = await setup();

    await send();

    await vi.waitFor(async () => expect(await titleOf()).toBe("Capital of France"));
    expect(adapterCalls).toEqual([
      { model: replyModel, credentials: { apiKey: "sk-ant-test-key" } },
      { model: replyModel, credentials: { apiKey: "sk-ant-test-key" } },
    ]);
    // The title call sees the first Message and the reply.
    const prompt = JSON.stringify(titleAdapter?.calls[0]?.messages);
    expect(prompt).toContain("What is the capital of France?");
    expect(prompt).toContain("Paris is the capital.");
  });

  it("uses the user's Background Model with its Provider's credentials", async () => {
    const { user, deps, send, titleOf, adapterCalls } = await setup();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    await saveBackgroundModel(deps, user.id, cheapModel);

    await send();

    await vi.waitFor(async () => expect(await titleOf()).toBe("Capital of France"));
    expect(adapterCalls[1]).toEqual({
      model: cheapModel,
      credentials: { apiKey: "sk-openai-test-key" },
    });
  });

  it("titles with a live-listed Background Model (OpenRouter)", async () => {
    const { user, deps, send, titleOf, adapterCalls } = await setup();
    await saveCredentials(deps, user.id, {
      service: "openrouter",
      fields: { apiKey: "sk-or-test-key" },
      hint: "…-key",
      verified: true,
    });
    await saveBackgroundModel(deps, user.id, "openrouter:mistralai/mistral-large");

    await send();

    await vi.waitFor(async () => expect(await titleOf()).toBe("Capital of France"));
    expect(adapterCalls[1]).toEqual({
      model: "openrouter:mistralai/mistral-large",
      credentials: { apiKey: "sk-or-test-key" },
    });
  });

  it("falls back to the start of the first Message without credentials for the Background Model", async () => {
    const { user, deps, send, titleOf, adapterCalls } = await setup();
    await saveBackgroundModel(deps, user.id, cheapModel);

    await send({ text: "How do I keep my sourdough starter alive over a two-week holiday?" });

    await vi.waitFor(async () =>
      expect(await titleOf()).toBe("How do I keep my sourdough starter alive over a…"),
    );
    expect(adapterCalls.map((call) => call.model)).toEqual([replyModel]);
  });

  it("falls back to the first Message when the title call fails", async () => {
    const { send, titleOf } = await setup({
      scripts: [[round(text("Hi."))], [round(runError("overloaded", "529"))]],
    });

    await send({ text: "Short question" });

    await vi.waitFor(async () => expect(await titleOf()).toBe("Short question"));
  });

  it("titles only after a run that ends complete", async () => {
    const { send, titleOf, adapterCalls, fakes } = await setup({
      scripts: [
        [round(runError("Invalid API key", "401"))],
        [round(text("Paris."))],
        [round(text("Retried title"))],
      ],
    });

    await send();
    // Had the failed run asked for a title, it would have taken one of the next two adapters.
    await send({ text: "Try again: capital of France?" });

    await vi.waitFor(async () => expect(await titleOf()).toBe("Retried title"));
    expect(adapterCalls).toHaveLength(3);
    expect(JSON.stringify(fakes[2]?.calls[0]?.messages)).toContain("Paris.");
  });
});

describe("titleConversation", () => {
  /** A Conversation with a first exchange, as the end of its first run leaves it. */
  async function seeded({ manual = false, title = null as string | null } = {}) {
    const user = await insertUser();
    const titleAdapter = createFakeAdapter({ rounds: [round(text("Generated title"))], manual });
    const deps = createTestDeps({ adapterFor: () => titleAdapter.adapter });
    await addAnthropicKey(user.id);
    const conv = await insertConversation(user, { model: replyModel, title });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "First question",
    });
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "First answer",
      active: true,
    });
    const titleOf = () => titleOfConversation(conv.id);
    return { user, deps, conv, reply, titleAdapter, titleOf };
  }

  it("leaves a renamed Conversation alone and makes no title call", async () => {
    const { deps, reply, titleAdapter, titleOf } = await seeded({ title: "My name" });

    await titleConversation(deps, reply.id);

    expect(await titleOf()).toBe("My name");
    expect(titleAdapter.calls).toHaveLength(0);
  });

  it("never overwrites a rename made while the title is being generated", async () => {
    const { user, deps, conv, reply, titleAdapter, titleOf } = await seeded({ manual: true });

    const job = titleConversation(deps, reply.id);
    await vi.waitFor(() => expect(titleAdapter.calls).toHaveLength(1));
    await chatRpc({ user, deps }).conversation.rename({ id: conv.id, title: "Mine" });
    await titleAdapter.releaseAll();
    await job;

    expect(await titleOf()).toBe("Mine");
  });
});
