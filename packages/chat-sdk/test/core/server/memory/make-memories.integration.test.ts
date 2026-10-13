import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { conversation, message } from "../../../../core/server/db/schema/chat";
import { job } from "../../../../core/server/db/schema/job";
import { memory } from "../../../../core/server/db/schema/memory";
import { userSettings } from "../../../../core/server/db/schema/settings";
import { usage } from "../../../../core/server/db/schema/usage";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, runError, text } from "../../../support/fake-adapter";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const replyModel = "anthropic:claude-sonnet-5-5";
const backgroundModel = "anthropic:claude-haiku-4-5";
const userText = "I'm vegetarian, and I live in Pune.";
const today = new Date("2026-10-14T10:00:00Z");

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [
    {
      modelId: "gpt-5.4-mini",
      maxOutputTokens: 1_000,
      inputUsdPerMillion: 0.25,
      outputUsdPerMillion: 2,
    },
  ],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
};

/**
 * A signed-in user with an Anthropic key for the reply, and an OpenAI key for embeddings unless
 * `ownEmbeddingKey` is false. The reply and the Background Model get their own fake adapters. The
 * Conversation has a title, so titling never calls the Background Model.
 */
async function setup({
  reply = [round(text("Noted: no meat in your recipes."))],
  replyManual = false,
  facts = [round(text('{"facts": ["Is vegetarian", "Lives in Pune"]}'))],
  ownEmbeddingKey = true,
  conversation: fields = {},
  deps: overrides = {},
}: {
  reply?: Rounds;
  replyManual?: boolean;
  facts?: Rounds;
  ownEmbeddingKey?: boolean;
  conversation?: Partial<typeof conversation.$inferInsert>;
  deps?: Partial<AppDeps>;
} = {}) {
  const user = await insertUser();
  const replyFake = createFakeAdapter({ rounds: reply, manual: replyManual });
  const memoryFake = createFakeAdapter({ rounds: facts });
  const deps = createTestDeps({
    defaultBackgroundModel: backgroundModel,
    clock: () => today,
    adapterFor: (model) => (model === replyModel ? replyFake.adapter : memoryFake.adapter),
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  if (ownEmbeddingKey) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-own-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const conv = await insertConversation(user, { model: replyModel, title: "Chat", ...fields });
  const post = (command: { parentId?: string | null } = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: userText,
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
  const send = async (command: { parentId?: string | null } = {}) => (await post(command)).text();
  return { user, deps, conv, post, send, memoryFake };
}

/** The Memory job a Run queues is fire-and-forget, so this waits for it, then runs it. */
async function drainMemory(deps: AppDeps) {
  await vi.waitFor(async () => expect(await drainJobs({ deps })).toBeGreaterThan(0));
}

/** For a test where no Memory job should run: lets the Run's enqueue settle, then checks none ran. */
async function expectNoMemoryJob(deps: AppDeps) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await drainJobs({ deps })).toBe(0);
}

const memoriesOf = (userId: string) =>
  getTestDb().select().from(memory).where(eq(memory.userId, userId));

async function messageOf(conversationId: string, role: "user" | "assistant") {
  const [row] = await getTestDb()
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, role)));
  if (!row) throw new Error(`No ${role} Message in the Conversation`);
  return row;
}

describe("making Memories after a Run", () => {
  it("adds a Memory per fact the user stated, from the user's Message, with its embedding", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();

    await send();
    await drainMemory(deps);

    const userMessage = await messageOf(conv.id, "user");
    const rows = await memoriesOf(user.id);
    expect(rows.map((row) => row.text).sort()).toEqual(["Is vegetarian", "Lives in Pune"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        origin: "extracted",
        conversationId: conv.id,
        sourceMessageId: userMessage.id,
        embeddingModel: "openai:text-embedding-3-small",
        invalidAt: null,
        replacedById: null,
        createdAt: today,
      });
      expect(row.embedding).toHaveLength(1536);
    }
    // The extract call reads the user's words and the reply as labelled turns, with today's date.
    const call = memoryFake.calls[0]!;
    expect(JSON.stringify(call.messages)).toContain(`User: ${userText}`);
    expect(JSON.stringify(call.messages)).toContain("Assistant: Noted: no meat in your recipes.");
    expect(JSON.stringify(call.systemPrompts)).toContain("Today's date is 2026-10-14");
    expect(JSON.stringify(call.systemPrompts)).not.toContain("publicly available sources");
  });

  it("reads the two Messages before the user's on the Branch, as context", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();
    const earlierUser = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "I'm learning Japanese.",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: earlierUser.id,
      role: "assistant",
      text: "Great, what level?",
      active: true,
    });

    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    expect(JSON.stringify(memoryFake.calls[0]!.messages)).toContain("I'm learning Japanese.");
    expect(await memoriesOf(user.id)).toHaveLength(2);
  });

  it("makes Memories from a Run that was stopped", async () => {
    const { user, deps, conv, post } = await setup({ replyManual: true });

    // The reply waits on a release that never comes, so Stop ends it as `stopped`.
    const posting = await post();
    await vi.waitFor(async () => expect(await messageOf(conv.id, "assistant")).toBeDefined());
    await chatRpc({ user, deps }).chat.stop({
      messageId: (await messageOf(conv.id, "assistant")).id,
    });
    await posting.text();

    await drainMemory(deps);
    expect((await memoriesOf(user.id)).map((row) => row.text)).toContain("Is vegetarian");
  });

  it("makes no job for a Run that errored", async () => {
    const { user, deps, send } = await setup({ reply: [round(runError("Provider down"))] });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job in a Temporary Conversation", async () => {
    const { user, deps, send } = await setup({ conversation: { temporary: true } });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job when the user has Memory off", async () => {
    const { user, deps, send } = await setup();
    await getTestDb().insert(userSettings).values({ userId: user.id, memoryEnabled: false });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job when the Host has Memory off", async () => {
    const { user, deps, send } = await setup({ deps: { memory: false } });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job with no Background Model and no Host default, and never uses the reply's Model", async () => {
    const { user, deps, send, memoryFake } = await setup({
      deps: { defaultBackgroundModel: null },
    });

    await send();

    await expectNoMemoryJob(deps);
    expect(memoryFake.calls).toEqual([]);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job with no embedding Model", async () => {
    const { user, deps, send } = await setup({ ownEmbeddingKey: false });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("adds nothing over Quota, and records the calls on Host credentials within it", async () => {
    const hosted = { hostProviders: [hostOpenAI], defaultBackgroundModel: "openai:gpt-5.4-mini" };

    const over = await setup({
      ownEmbeddingKey: false,
      deps: { ...hosted, getQuota: async () => ({ budgetUsd: 0, window: "day" }) },
    });
    await over.send();
    // The job runs and ends quietly: no call on the Background Model, no Memory, and no error.
    await drainMemory(over.deps);
    expect(over.memoryFake.calls).toEqual([]);
    expect(await memoriesOf(over.user.id)).toEqual([]);
    const jobs = await getTestDb().select().from(job).where(eq(job.name, "memory.make"));
    expect(jobs.map((row) => row.status)).toEqual(["succeeded"]);

    const within = await setup({
      ownEmbeddingKey: false,
      deps: { ...hosted, getQuota: async () => ({ budgetUsd: 10, window: "day" }) },
    });
    await within.send();
    await drainMemory(within.deps);

    expect(await memoriesOf(within.user.id)).toHaveLength(2);
    const kinds = (await getTestDb().select().from(usage).where(eq(usage.userId, within.user.id)))
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["embedding", "memory"]);
  });

  it("adds nothing when the same user Message is processed again", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();
    await send();
    await drainMemory(deps);
    const replyId = (await messageOf(conv.id, "assistant")).id;

    // A replayed job, or a regenerated reply, on the same user Message.
    const key = `memory-replay:${replyId}`;
    await deps.jobs.enqueue(
      "memory.make",
      { userId: user.id, conversationId: conv.id, replyId },
      { idempotencyKey: key },
    );
    await drainMemory(deps);

    expect(await memoriesOf(user.id)).toHaveLength(2);
    expect(memoryFake.calls).toHaveLength(1);
    const [replayed] = await getTestDb().select().from(job).where(eq(job.idempotencyKey, key));
    expect(replayed?.status).toBe("succeeded");
  });
});
