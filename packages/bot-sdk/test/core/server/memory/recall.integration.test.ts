import { randomUUID } from "node:crypto";

import { embed } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeEmbeddingAdapter } from "../../../../plugins/models/server/fake-embedding-adapter";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  conversation,
  project,
  memory,
  userSettings,
  usage,
} from "../../../../core/server/db/schema";
import type { HostProvider } from "../../../../core/server/deps";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const replyModel = "anthropic:claude-sonnet-5-5";
const embeddingModel = "openai:text-embedding-3-small";
const today = new Date("2026-10-14T10:00:00Z");
const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
};

/** Inserts Memories for `userId`, each in `conversationId`, embedded the way the job would. */
async function seedMemories(
  userId: string,
  conversationId: string,
  rows: Array<{ text: string; createdAt: Date; invalidAt?: Date }>,
) {
  const { embeddings } = await embed({
    adapter: fakeEmbeddingAdapter(),
    input: rows.map((row) => row.text),
    dimensions: 1536,
  });
  await getTestDb()
    .insert(memory)
    .values(
      rows.map((row, i) => ({
        id: uuidv7(row.createdAt.getTime()),
        userId,
        text: row.text,
        embedding: embeddings[i]!.vector,
        embeddingModel: embeddingModel,
        conversationId,
        sourceMessageId: randomUUID(),
        origin: "extracted" as const,
        invalidAt: row.invalidAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      })),
    );
}

/** Thirty dated Memories, oldest first, each one's text a numbered filler. */
const fillers = (count: number, start = 0) =>
  Array.from({ length: count }, (_, i) => ({
    text: `Filler fact number ${start + i} about gardening`,
    createdAt: new Date(Date.UTC(2026, 1, 1 + start + i)),
  }));

/** Sets up a signed-in user with an Anthropic key for the reply and a Conversation to send from. */
async function setup({
  reply = [round(text("Noted."))],
  conversation: fields = {},
  ownEmbeddingKey = true,
  deps: overrides = {},
}: {
  reply?: Parameters<typeof createFakeAdapter>[0]["rounds"];
  conversation?: Partial<typeof conversation.$inferInsert>;
  ownEmbeddingKey?: boolean;
  deps?: TestDepsOverrides;
} = {}) {
  const user = await insertUser();
  const replyFake = createFakeAdapter({ rounds: reply });
  const deps = createTestSdk({
    clock: () => today,
    adapterFor: () => replyFake.adapter,
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
  const send = async (text = "Where did I park my bicycle?") =>
    (
      await sendAs(
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
              model: replyModel,
              webSearch: false,
            },
          }),
        }),
        user,
        deps,
      )
    ).text();
  return { user, deps, conv, send, replyFake };
}

/** The reply's system prompts, as the fake Model received them. */
const promptsOf = (replyFake: { calls: Array<{ systemPrompts?: unknown[] }> }) =>
  (replyFake.calls[0]!.systemPrompts ?? []).map(String);

/** The Memories block the Run sent, or `undefined` when it sent none. */
const blockOf = (replyFake: { calls: Array<{ systemPrompts?: unknown[] }> }) =>
  promptsOf(replyFake).find((prompt) => prompt.startsWith("Memories"));

/** The bullet lines of the Memories block. */
const linesOf = (block: string | undefined) =>
  (block ?? "").split("\n").filter((line) => line.startsWith("- "));

describe("recalling Memories in a Run", () => {
  it("sends the Memories after the Instructions and the Project's, one dated line each", async () => {
    const { user, conv, send, replyFake } = await setup();
    const projectId = uuidv7();
    await getTestDb()
      .insert(project)
      .values({ id: projectId, userId: user.id, name: "Thesis", instructions: "Cite sources." });
    await getTestDb().update(conversation).set({ projectId }).where(eq(conversation.id, conv.id));
    await getTestDb()
      .insert(userSettings)
      .values({ userId: user.id, instructions: "Answer briefly." });
    await seedMemories(user.id, conv.id, [
      { text: "Is vegetarian", createdAt: new Date("2026-09-01T00:00:00Z") },
    ]);

    await send();

    const prompts = promptsOf(replyFake);
    expect(prompts.slice(0, 2)).toEqual(["Answer briefly.", "Cite sources."]);
    expect(prompts[2]).toContain("may be outdated");
    expect(prompts[2]).toContain("Instructions win");
    expect(prompts[2]).toContain("saved or forgotten right after your reply");
    expect(linesOf(prompts[2])).toEqual(["- 2026-09-01: Is vegetarian"]);
  });

  it("with 30 or fewer Memories in scope, sends them all and embeds nothing", async () => {
    const embeddings = fakeEmbeddingAdapter();
    const { user, conv, send, replyFake } = await setup({
      deps: { embeddingAdapterFor: () => embeddings },
    });
    await seedMemories(user.id, conv.id, fillers(30));

    await send();

    expect(linesOf(blockOf(replyFake))).toHaveLength(30);
    expect(embeddings.calls).toEqual([]);
  });

  it("past 30, sends the 20 newest and the 10 closest of the rest by similarity", async () => {
    const { user, conv, send, replyFake } = await setup();
    await seedMemories(user.id, conv.id, [
      { text: "Owns a red bicycle named Pedal", createdAt: new Date("2026-01-01T00:00:00Z") },
      ...fillers(30),
    ]);

    await send("Where did I park my bicycle?");

    const lines = linesOf(blockOf(replyFake));
    expect(lines).toHaveLength(30);
    expect(lines).toContain("- 2026-01-01: Owns a red bicycle named Pedal");
    expect(lines).toContain(
      // The 20 newest fillers are numbers 10 to 29; number 10 is the oldest of them.
      "- 2026-02-11: Filler fact number 10 about gardening",
    );
  });

  it("when the embedding fails, sends the profile only and the Run goes ahead", async () => {
    const { user, conv, send, replyFake } = await setup({
      deps: { embeddingAdapterFor: () => fakeEmbeddingAdapter({ fail: "embedding down" }) },
    });
    await seedMemories(user.id, conv.id, [
      { text: "Owns a red bicycle named Pedal", createdAt: new Date("2026-01-01T00:00:00Z") },
      ...fillers(30),
    ]);

    const body = await send("Where did I park my bicycle?");

    expect(body).toContain("Noted.");
    const lines = linesOf(blockOf(replyFake));
    expect(lines).toHaveLength(20);
    expect(lines.join("\n")).not.toContain("bicycle");
  });

  it("uses a project's Memories and the general ones in a Project Run, and only the general ones elsewhere", async () => {
    const { user, conv, send, replyFake } = await setup({
      reply: [round(text("Noted.")), round(text("Noted."))],
    });
    const [projectA, projectB] = [uuidv7(), uuidv7()];
    await getTestDb()
      .insert(project)
      .values([
        { id: projectA, userId: user.id, name: "A" },
        { id: projectB, userId: user.id, name: "B" },
      ]);
    const inA = await insertConversation(user, { projectId: projectA });
    const inB = await insertConversation(user, { projectId: projectB });
    const general = await insertConversation(user, {});
    const when = new Date("2026-09-01T00:00:00Z");
    await seedMemories(user.id, general.id, [{ text: "General alpha", createdAt: when }]);
    await seedMemories(user.id, inA.id, [{ text: "Project A beta", createdAt: when }]);
    await seedMemories(user.id, inB.id, [{ text: "Project B gamma", createdAt: when }]);
    await seedMemories(user.id, general.id, [
      { text: "Retired delta", createdAt: when, invalidAt: when },
    ]);
    await getTestDb()
      .update(conversation)
      .set({ projectId: projectA })
      .where(eq(conversation.id, conv.id));

    await send();
    const inProject = linesOf(blockOf(replyFake)).join("\n");
    expect(inProject).toContain("General alpha");
    expect(inProject).toContain("Project A beta");
    expect(inProject).not.toContain("Project B gamma");
    expect(inProject).not.toContain("Retired delta");

    await getTestDb()
      .update(conversation)
      .set({ projectId: null })
      .where(eq(conversation.id, conv.id));
    await send();
    const outside = linesOf(blockOf({ calls: replyFake.calls.slice(1) })).join("\n");
    expect(outside).toContain("General alpha");
    expect(outside).not.toContain("Project A beta");
    expect(outside).not.toContain("Project B gamma");
  });

  it("sends nothing in a Temporary Conversation", async () => {
    const { user, conv, send, replyFake } = await setup({ conversation: { temporary: true } });
    await seedMemories(user.id, conv.id, [
      { text: "Is vegetarian", createdAt: new Date("2026-09-01T00:00:00Z") },
    ]);

    await send();

    expect(blockOf(replyFake)).toBeUndefined();
  });

  it("sends nothing with Memory off for the user", async () => {
    const { user, conv, send, replyFake } = await setup();
    await getTestDb().insert(userSettings).values({ userId: user.id, memoryEnabled: false });
    await seedMemories(user.id, conv.id, [
      { text: "Is vegetarian", createdAt: new Date("2026-09-01T00:00:00Z") },
    ]);

    await send();

    expect(blockOf(replyFake)).toBeUndefined();
  });

  it("sends nothing with Memory off for the Host", async () => {
    const { user, conv, send, replyFake } = await setup({ deps: { memory: false } });
    await seedMemories(user.id, conv.id, [
      { text: "Is vegetarian", createdAt: new Date("2026-09-01T00:00:00Z") },
    ]);

    await send();

    expect(blockOf(replyFake)).toBeUndefined();
  });

  it("writes one embedding usage row on Host credentials for the similarity lookup", async () => {
    const { user, conv, send } = await setup({
      ownEmbeddingKey: false,
      deps: { hostProviders: [hostOpenAI] },
    });
    await seedMemories(user.id, conv.id, fillers(31));

    await send();

    const rows = await getTestDb()
      .select()
      .from(usage)
      .where(and(eq(usage.userId, user.id), eq(usage.kind, "embedding")));
    expect(rows).toHaveLength(1);
  });
});
