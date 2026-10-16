import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { project, memory, userSettings } from "../../../../core/server/db/schema";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import type { TestUser } from "../../../support/users";

const replyModel = "anthropic:claude-sonnet-5-5";
const backgroundModel = "anthropic:claude-haiku-4-5";
const embeddingModel = "openai:text-embedding-3-small";
const now = new Date("2026-10-14T10:00:00Z");

/** A unit vector, stored as a Memory's embedding in these tests. */
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

/** A Memory row, inserted straight into the test database. */
async function insertMemory(
  user: TestUser,
  conversationId: string,
  sourceMessageId: string,
  fields: Partial<typeof memory.$inferInsert> = {},
) {
  const [row] = await getTestDb()
    .insert(memory)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      text: "Is vegetarian",
      embedding: vector,
      embeddingModel,
      conversationId,
      sourceMessageId,
      origin: "extracted",
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    .returning();
  if (!row) throw new Error("Inserting the test Memory returned no row");
  return row;
}

/** A user with a general Conversation holding one user Message, and the RPC client for them. */
async function setup(deps: TestDeps = createTestSdk()) {
  const user = await insertUser();
  const conv = await insertConversation(user, { title: "Diet chat" });
  const message = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
  return { user, conv, message, deps, rpc: chatRpc({ user, deps }) };
}

const memoriesOf = (userId: string) =>
  getTestDb().select().from(memory).where(eq(memory.userId, userId));

describe("the Memory page procedures", () => {
  it("lists valid Memories grouped General first, then by Project, never outdated ones", async () => {
    const { user, conv, message, rpc } = await setup();
    const [work] = await getTestDb()
      .insert(project)
      .values({ id: crypto.randomUUID(), userId: user.id, name: "Thesis" })
      .returning();
    const inProject = await insertConversation(user, {
      title: "Chapter two",
      projectId: work!.id,
    });
    const projectMessage = await insertMessage({
      conversationId: inProject.id,
      role: "user",
      text: "Draft",
    });
    await insertMemory(user, conv.id, message.id, { text: "Lives in Pune" });
    await insertMemory(user, inProject.id, projectMessage.id, { text: "Advisor is Dr. Rao" });
    await insertMemory(user, conv.id, message.id, { text: "Old personal best", invalidAt: now });

    const { groups } = await rpc.memory.list();

    expect(groups.map((group) => group.projectName)).toEqual([null, "Thesis"]);
    expect(groups[0]!.items).toMatchObject([
      {
        text: "Lives in Pune",
        conversationTitle: "Diet chat",
        sourceMessageId: message.id,
        origin: "extracted",
      },
    ]);
    expect(groups[1]!.items.map((item) => item.text)).toEqual(["Advisor is Dr. Rao"]);
    expect(groups[1]!.items[0]).toMatchObject({
      conversationTitle: "Chapter two",
      sourceMessageId: projectMessage.id,
    });
  });

  it("edits a Memory's text, re-embeds it with the user's embedding Model and keeps its source", async () => {
    const { user, conv, message, deps, rpc } = await setup();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-own-key" },
      hint: "…-key",
      verified: true,
    });
    const row = await insertMemory(user, conv.id, message.id, { embeddingModel: "openai:old" });

    await rpc.memory.edit({ id: row.id, text: "  Is vegan now  " });

    const [after] = await getTestDb().select().from(memory).where(eq(memory.id, row.id));
    expect(after).toMatchObject({
      text: "Is vegan now",
      embeddingModel: embeddingModel,
      conversationId: conv.id,
      sourceMessageId: message.id,
      origin: "extracted",
    });
    expect(after!.embedding).toHaveLength(1536);
  });

  it("refuses to edit an outdated Memory, and a blank text", async () => {
    const { user, conv, message, rpc } = await setup();
    const outdated = await insertMemory(user, conv.id, message.id, { invalidAt: now });
    const valid = await insertMemory(user, conv.id, message.id);

    await expect(rpc.memory.edit({ id: outdated.id, text: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(rpc.memory.edit({ id: valid.id, text: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("hard-deletes one Memory, and all of them", async () => {
    const { user, conv, message, rpc } = await setup();
    const first = await insertMemory(user, conv.id, message.id);
    await insertMemory(user, conv.id, message.id, { invalidAt: now });
    await insertMemory(user, conv.id, message.id);

    await rpc.memory.delete({ id: first.id });
    expect(await memoriesOf(user.id)).toHaveLength(2);

    await rpc.memory.deleteAll();
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("gets and sets the Memory switch, and reports whether an embedding Model is available", async () => {
    const { user, rpc } = await setup();

    expect(await rpc.memory.status()).toEqual({
      hostEnabled: true,
      enabled: true,
      embeddingAvailable: false,
    });

    await rpc.memory.setEnabled({ enabled: false });
    const [settings] = await getTestDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id));
    expect(settings?.memoryEnabled).toBe(false);
    expect((await rpc.memory.status()).enabled).toBe(false);
  });

  it("reports an embedding Model when the user has an OpenAI key", async () => {
    const { user, deps, rpc } = await setup();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-own-key" },
      hint: "…-key",
      verified: true,
    });

    expect((await rpc.memory.status()).embeddingAvailable).toBe(true);
  });

  it("refuses every procedure when the Host has Memory off, and says so in status", async () => {
    const { user, conv, message } = await setup();
    const deps = createTestSdk({ memory: false });
    await insertMemory(user, conv.id, message.id);
    const rpc = chatRpc({ user, deps });

    expect(await rpc.memory.status()).toMatchObject({ hostEnabled: false });
    await expect(rpc.memory.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rpc.memory.deleteAll()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await memoriesOf(user.id)).toHaveLength(1);
  });

  it("refuses another user's Memory", async () => {
    const { conv, message, rpc } = await setup();
    const other = await insertUser();
    const row = await insertMemory(other, conv.id, message.id);

    await expect(rpc.memory.delete({ id: row.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("re-embedding Memories when the embedding Model changes", () => {
  it("re-embeds the valid Memories made with another Model after a Run, and keeps their text", async () => {
    const user = await insertUser();
    const replyFake = createFakeAdapter({ rounds: [round(text("Noted."))] });
    // No new facts, so the Memory job only re-embeds.
    const memoryFake = createFakeAdapter({ rounds: [round(text('{"facts": []}'))] });
    const deps = createTestSdk({
      defaultBackgroundModel: backgroundModel,
      clock: () => now,
      adapterFor: (model) => (model === replyModel ? replyFake.adapter : memoryFake.adapter),
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-own-key" },
      hint: "…-key",
      verified: true,
    });
    const conv = await insertConversation(user, { model: replyModel, title: "Chat" });
    const stale = await insertMemory(user, conv.id, crypto.randomUUID(), {
      text: "Lives in Pune",
      embeddingModel: "gemini:old",
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
            text: "Hello again",
            attachmentIds: [],
            model: replyModel,
            webSearch: false,
          },
        }),
      }),
      user,
      deps,
    );
    await response.text();
    await vi.waitFor(async () => expect(await drainJobs({ deps })).toBeGreaterThan(0));

    const [after] = await getTestDb().select().from(memory).where(eq(memory.id, stale.id));
    expect(after).toMatchObject({ text: "Lives in Pune", embeddingModel: embeddingModel });
  });
});
