import { conversation, message } from "../../../../core/server/db/schema/chat";
import { and, eq } from "drizzle-orm";
import { getTestDb } from "../../../support/test-database";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { liveModelsFetch } from "../../../support/live-models";
import { sendAs } from "../../../support/sdk";
import { findModel } from "../../../../core/shared/chat/models";

/** One curated Model per Provider with a known max output, and the key its adapter reads. */
const providers: Array<{ id: string; service: string; key: string }> = [
  { id: "anthropic:claude-sonnet-5-5", service: "anthropic", key: "max_tokens" },
  { id: "openai:gpt-5.6", service: "openai", key: "max_output_tokens" },
  { id: "gemini:gemini-3.8-flash", service: "gemini", key: "maxOutputTokens" },
  { id: "mistral:mistral-medium-latest", service: "mistral", key: "max_tokens" },
  { id: "groq:openai/gpt-oss-120b", service: "groq", key: "max_completion_tokens" },
  { id: "grok:grok-4.7", service: "grok", key: "max_output_tokens" },
  {
    id: "bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0",
    service: "bedrock",
    key: "max_completion_tokens",
  },
  { id: "cloudflare:@cf/openai/gpt-oss-120b", service: "cloudflare", key: "max_tokens" },
  { id: "byteplus:seed-2-0-lite-260428", service: "byteplus", key: "max_completion_tokens" },
  { id: "llmgateway:claude-sonnet-5", service: "llmgateway", key: "max_completion_tokens" },
  {
    id: "lovable:google/gemini-3.1-pro-preview",
    service: "lovable",
    key: "max_completion_tokens",
  },
  {
    id: "vercel-gateway:anthropic/claude-sonnet-5.5",
    service: "vercel-gateway",
    key: "max_completion_tokens",
  },
];

const everyMaxKey = [...new Set(providers.map((provider) => provider.key))];

/** Runs one reply on `model` and returns the options the adapter was called with. */
async function runOn(model: string, service: string) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds: [round(text("Hi."))] });
  const deps = createTestDeps({ adapterFor: () => fake.adapter });
  await saveCredentials(deps, user.id, {
    service,
    fields: { apiKey: "test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so no title call takes the scripted adapter.
  const conv = await insertConversation(user, { model, title: "Test Conversation" });
  const response = await sendAs(
    new Request("http://localhost/api/chat/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId: conv.id,
          parentId: null,
          text: "Hello",
          attachmentIds: [],
          model,
          webSearch: false,
        },
      }),
    }),
    user,
    deps,
  );
  await response.text();
  return fake.calls[0]?.modelOptions as Record<string, unknown> | undefined;
}

describe("generation settings on a Run", () => {
  it.each(providers)("sends $id's max output under its own key", async ({ id, service, key }) => {
    const options = await runOn(id, service);
    const limit = maxOutputOf(id);
    expect(options?.[key]).toBe(limit);
  });

  it("sends no max output key for a Model whose limit is unknown", async () => {
    const options = await runOn("groq:qwen/qwen3-32b", "groq");
    for (const key of everyMaxKey) expect(options ?? {}).not.toHaveProperty(key);
  });
});

/** The max output the curated snapshot holds for `id`, which the Run must send. */
function maxOutputOf(id: string): number {
  const limit = findModel(id)?.maxOutputTokens;
  if (limit == null) throw new Error(`${id} has no known max output`);
  return limit;
}

describe("reasoning effort on a Run", () => {
  /** Runs one reply in a Conversation that stores `reasoningEffort`, returning its options and rows. */
  async function runWithEffort(
    model: string,
    service: string,
    reasoningEffort: "off" | "high",
    fetch?: typeof globalThis.fetch,
  ) {
    const user = await insertUser();
    const fake = createFakeAdapter({ rounds: [round(text("Hi."))] });
    const deps = createTestDeps({ adapterFor: () => fake.adapter, ...(fetch && { fetch }) });
    await saveCredentials(deps, user.id, {
      service,
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
    const conv = await insertConversation(user, {
      model,
      title: "Test Conversation",
      reasoningEffort,
    });
    const response = await sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Hello",
            attachmentIds: [],
            model,
            webSearch: false,
          },
        }),
      }),
      user,
      deps,
    );
    await response.text();
    const [reply] = await getTestDb()
      .select()
      .from(message)
      .where(and(eq(message.conversationId, conv.id), eq(message.role, "assistant")));
    const [stored] = await getTestDb()
      .select({ reasoningEffort: conversation.reasoningEffort })
      .from(conversation)
      .where(eq(conversation.id, conv.id));
    return {
      options: fake.calls[0]?.modelOptions as Record<string, unknown> | undefined,
      recorded: reply?.reasoningEffort,
      stored: stored?.reasoningEffort,
    };
  }

  it("sends the Conversation's effort and records it on the reply", async () => {
    const { options, recorded, stored } = await runWithEffort(
      "anthropic:claude-sonnet-5-5",
      "anthropic",
      "high",
    );

    expect(options).toMatchObject({ effort: "high", thinking: { type: "adaptive" } });
    expect(recorded).toBe("high");
    expect(stored).toBe("high");
  });

  it("sends the Model's default and records null when the Model doesn't offer the choice", async () => {
    // Haiku 4.5 has no reasoning control, so `high` doesn't apply and the Model's default runs.
    const { options, recorded, stored } = await runWithEffort(
      "anthropic:claude-haiku-4-5",
      "anthropic",
      "high",
    );

    expect(options).not.toHaveProperty("effort");
    expect(options).not.toHaveProperty("thinking");
    expect(recorded).toBeNull();
    expect(stored).toBe("high");
  });

  it("sends the effort on an OpenRouter live Model that lists efforts", async () => {
    const live = liveModelsFetch({
      openRouterReasoning: { "anthropic/claude-sonnet-5.5": ["low", "high"] },
    });

    const { options, recorded } = await runWithEffort(
      "openrouter:anthropic/claude-sonnet-5.5",
      "openrouter",
      "high",
      live.fetch,
    );

    expect(options).toMatchObject({ reasoning: { effort: "high" } });
    expect(recorded).toBe("high");
  });

  it("maps `off` to the Provider's off setting where the Model allows it", async () => {
    const { options, recorded } = await runWithEffort("openai:gpt-5.6", "openai", "off");

    expect(options).toMatchObject({ reasoning: { effort: "none" } });
    expect(recorded).toBe("off");
  });
});
