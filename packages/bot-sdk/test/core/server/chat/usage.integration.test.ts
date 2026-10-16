import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversation, message } from "../../../../core/server/db/schema/chat";
import { usage } from "../../../../core/server/db/schema/usage";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, runError, text, withUsage } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";

const sonnet = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens and $15 per 1M output tokens, so a token costs as many micros as its price.
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

function chatRequest(command: Record<string, unknown>) {
  // useChat posts an AG-UI RunAgentInput; our command rides in `forwardedProps`.
  return new Request("http://localhost/api/chat/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], forwardedProps: command }),
  });
}

/** A signed-in user on a Host Model with a scripted adapter, and an empty titled Conversation. */
async function setup({
  user,
  rounds,
  manual = false,
  deps: overrides = {},
}: {
  user?: TestUser;
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  manual?: boolean;
  deps?: TestDepsOverrides;
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds, manual });
  const deps: AppDeps = createTestDeps({
    hostProviders,
    adapterFor: () => fake.adapter,
    ...overrides,
  });
  // Titled, so no automatic title call takes the scripted adapter.
  const conv = await insertConversation(owner, { model: sonnet, title: "Test Conversation" });
  const send = () =>
    sendAs(
      chatRequest({
        conversationId: conv.id,
        parentId: null,
        text: "Hi",
        attachmentIds: [],
        model: sonnet,
        webSearch: false,
      }),
      owner,
      deps,
    );
  return { owner, deps, conv, fake, send };
}

/** The usage rows of a user, without their ids and creation times. */
async function usageOf(userId: string) {
  const rows = await getTestDb().select().from(usage).where(eq(usage.userId, userId));
  return rows.map(({ id: _id, createdAt: _createdAt, ...row }) => row);
}

describe("chat.usage for a Run", () => {
  it("writes one row for a Run on a Host Model, priced from the tokens it used", async () => {
    const { owner, send } = await setup({
      rounds: [
        withUsage(round(text("Hello")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      ],
    });

    await (await send()).text();

    expect(await usageOf(owner.id)).toEqual([
      {
        userId: owner.id,
        kind: "run",
        model: sonnet,
        inputTokens: 100,
        outputTokens: 50,
        // 100 × $3/M + 50 × $15/M = $0.00105
        costMicros: 1050,
        estimated: false,
      },
    ]);
  });

  it("writes no row for the same Model on the user's own key", async () => {
    const owner = await insertUser();
    const { send, deps } = await setup({
      user: owner,
      rounds: [
        withUsage(round(text("Hello")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      ],
    });
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send()).text();

    expect(await usageOf(owner.id)).toEqual([]);
  });

  it("uses the cost the Provider reports over the tokens times the Model's price", async () => {
    const { owner, send } = await setup({
      rounds: [
        withUsage(round(text("Hello")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cost: 0.002,
        }),
      ],
    });

    await (await send()).text();

    expect(await usageOf(owner.id)).toMatchObject([{ costMicros: 2000, estimated: false }]);
  });

  it("prices the tokens, not a reported cost, when only some iterations report one", async () => {
    const { owner, send } = await setup({
      rounds: [
        [
          ...withUsage(round(text("First")), {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            cost: 0.002,
          }),
          ...withUsage(round(text("Second")), {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          }),
        ],
      ],
    });

    await (await send()).text();

    // 110 × $3/M + 55 × $15/M = 1155 micros; the 2000 reported for the first iteration alone would undercount.
    expect(await usageOf(owner.id)).toMatchObject([{ costMicros: 1155, estimated: false }]);
  });

  it("sums the usage of every RUN_FINISHED in one Run", async () => {
    const { owner, send } = await setup({
      rounds: [
        [
          ...withUsage(round(text("First")), {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          }),
          ...withUsage(round(text("Second")), {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          }),
        ],
      ],
    });

    await (await send()).text();

    expect(await usageOf(owner.id)).toMatchObject([
      { inputTokens: 110, outputTokens: 55, costMicros: 1155, estimated: false },
    ]);
  });

  it("estimates a complete Run that reported no usage, from its characters, and marks it estimated", async () => {
    const { owner, send } = await setup({ rounds: [round(text("Hello"))] });

    await (await send()).text();

    const [row] = await usageOf(owner.id);
    // "Hello" is 5 characters, so ceil(5 ÷ 4) = 2 output tokens.
    expect(row).toMatchObject({ outputTokens: 2, estimated: true });
    expect(row?.costMicros).toBe((row?.inputTokens ?? 0) * 3 + 2 * 15);
  });

  it("estimates a failed Run, which ends in a RUN_ERROR", async () => {
    const { owner, send } = await setup({ rounds: [runError("Overloaded")] });

    await (await send()).text();

    expect(await usageOf(owner.id)).toMatchObject([{ outputTokens: 0, estimated: true }]);
  });

  it("estimates a stopped Run, even when its round reported usage", async () => {
    const owner = await insertUser();
    const { deps, conv, fake, send } = await setup({
      user: owner,
      manual: true,
      rounds: [
        withUsage(round(text("Hello", " there!")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      ],
    });
    const response = await send();
    const [reply] = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(eq(message.conversationId, conv.id))
      .orderBy(message.createdAt);
    await fake.release(3);

    await chatRpc({ user: owner, deps }).chat.stop({ messageId: reply!.id });
    await response.text();

    expect(await usageOf(owner.id)).toMatchObject([{ estimated: true }]);
  });

  it("keeps the usage when its Conversation is deleted", async () => {
    const { owner, conv, send } = await setup({
      rounds: [
        withUsage(round(text("Hello")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      ],
    });
    await (await send()).text();

    await getTestDb().delete(conversation).where(eq(conversation.id, conv.id));

    expect(await usageOf(owner.id)).toHaveLength(1);
  });
});
