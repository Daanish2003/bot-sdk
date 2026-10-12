import { EventType } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { getTestDb } from "../../../support/test-database";

import { afterEach, describe, expect, it, vi } from "vitest";

import { START } from "../../../../core/server/chat/run-streams";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, text } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { chatRpc, createTestChat } from "../../../support/sdk";

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user }) };
}

describe("project.create", () => {
  it("creates a Project with the given name and returns its id", async () => {
    const { client } = await signedIn();

    const { id } = await client.project.create({ name: "  Thesis  " });

    await expect(client.project.get({ id })).resolves.toEqual({
      id,
      name: "Thesis",
      defaultModel: null,
      instructions: null,
    });
  });

  it("refuses a blank name and a name longer than 100 characters", async () => {
    const { client } = await signedIn();

    await expect(client.project.create({ name: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.project.create({ name: "x".repeat(101) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("accepts a name of exactly 100 characters", async () => {
    const { client } = await signedIn();

    await expect(client.project.create({ name: "x".repeat(100) })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("refuses a 101st Project for one user, and another user's Projects don't count", async () => {
    const { user, client } = await signedIn();
    const other = await insertUser();
    await getTestDb()
      .insert(project)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          id: uuidv7(),
          userId: user.id,
          name: `Project ${i}`,
        })),
      );

    await expect(client.project.create({ name: "One too many" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(chatRpc({ user: other }).project.create({ name: "Mine" })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("rejects signed-out callers", async () => {
    await expect(chatRpc({}).project.create({ name: "Nope" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("project.update", () => {
  async function withOpenAiCredentials() {
    const { user, client } = await signedIn();
    await saveCredentials(createTestDeps(), user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    return { user, client };
  }

  it("renames the Project, sets its default Model, and clears the Model with null", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });

    await client.project.update({ id, name: "Thesis v2", defaultModel: "openai:gpt-5.6" });
    await expect(client.project.get({ id })).resolves.toEqual({
      id,
      name: "Thesis v2",
      defaultModel: "openai:gpt-5.6",
      instructions: null,
    });

    await client.project.update({ id, name: "Thesis v2", defaultModel: null });
    await expect(client.project.get({ id })).resolves.toMatchObject({ defaultModel: null });
  });

  it("keeps the default Model when the input leaves it out", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });
    await client.project.update({ id, name: "Thesis", defaultModel: "openai:gpt-5.6" });

    await client.project.update({ id, name: "Renamed" });

    await expect(client.project.get({ id })).resolves.toEqual({
      id,
      name: "Renamed",
      defaultModel: "openai:gpt-5.6",
      instructions: null,
    });
  });

  it("refuses a default Model that isn't available", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });

    await expect(
      client.project.update({ id, name: "Thesis", defaultModel: "openai:gpt-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.project.get({ id })).resolves.toMatchObject({ defaultModel: null });
  });

  it("refuses a default Model whose Provider the user has no credentials for", async () => {
    const { client } = await signedIn();
    const { id } = await client.project.create({ name: "Thesis" });

    await expect(
      client.project.update({ id, name: "Thesis", defaultModel: "openai:gpt-5.6" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a blank name", async () => {
    const { client } = await signedIn();
    const { id } = await client.project.create({ name: "Thesis" });

    await expect(client.project.update({ id, name: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("answers NOT_FOUND for another user's Project", async () => {
    const other = await insertUser();
    const { id } = await chatRpc({ user: other }).project.create({ name: "Theirs" });
    const { client } = await signedIn();

    await expect(client.project.update({ id, name: "Mine now" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(chatRpc({ user: other }).project.get({ id })).resolves.toMatchObject({
      name: "Theirs",
    });
  });

  it("still renames a Project whose stored default Model is no longer available", async () => {
    const { user, client } = await signedIn();
    const id = uuidv7();
    await getTestDb()
      .insert(project)
      .values({ id, userId: user.id, name: "Old", defaultModel: "openai:gpt-2" });

    await client.project.update({ id, name: "New name" });

    await expect(client.project.get({ id })).resolves.toEqual({
      id,
      name: "New name",
      defaultModel: "openai:gpt-2",
      instructions: null,
    });
  });

  it("rejects signed-out callers", async () => {
    const other = await insertUser();
    const { id } = await chatRpc({ user: other }).project.create({ name: "Theirs" });

    await expect(chatRpc({}).project.update({ id, name: "Nope" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("project.list", () => {
  it("lists only the caller's Projects, by latest activity, newest first", async () => {
    const { user, client } = await signedIn();
    const other = await insertUser();
    const quiet = uuidv7();
    const busy = uuidv7();
    const fresh = uuidv7();
    await getTestDb()
      .insert(project)
      .values([
        { id: quiet, userId: user.id, name: "Quiet", createdAt: new Date("2026-09-01T00:00:00Z") },
        { id: busy, userId: user.id, name: "Busy", createdAt: new Date("2026-08-01T00:00:00Z") },
        { id: fresh, userId: user.id, name: "Fresh", createdAt: new Date("2026-10-05T00:00:00Z") },
        { id: uuidv7(), userId: other.id, name: "Theirs" },
      ]);
    // "Busy" was created longest ago, but its newest Conversation is the most recent activity.
    await insertConversation(user, {
      projectId: busy,
      lastMessageAt: new Date("2026-10-09T12:00:00Z"),
    });

    const { items } = await client.project.list({});

    expect(items.map((item) => item.name)).toEqual(["Busy", "Fresh", "Quiet"]);
  });

  it("answers an empty list for a user without Projects", async () => {
    const { client } = await signedIn();

    await expect(client.project.list({})).resolves.toEqual({ items: [] });
  });
});

describe("project.get", () => {
  it("answers NOT_FOUND for another user's Project", async () => {
    const other = await insertUser();
    const [row] = await getTestDb()
      .insert(project)
      .values({ id: uuidv7(), userId: other.id, name: "Theirs" })
      .returning();
    const { client } = await signedIn();

    await expect(client.project.get({ id: row!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("conversation.create in a Project", () => {
  it("creates the Conversation inside the caller's Project", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });

    const { id } = await client.conversation.create({ model: "openai:gpt-5.6", projectId });

    const [row] = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
    expect(row).toMatchObject({ userId: user.id, projectId });
  });

  it("answers NOT_FOUND for another user's Project", async () => {
    const other = await insertUser();
    const { id: projectId } = await chatRpc({ user: other }).project.create({ name: "Theirs" });
    const { client } = await signedIn();

    await expect(
      client.conversation.create({ model: "openai:gpt-5.6", projectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("conversation.list in a Project", () => {
  it("lists the Project's Conversations, newest first, and leaves them out of the main list", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const inProject = await insertConversation(user, {
      projectId,
      lastMessageAt: new Date("2026-10-08T10:00:00Z"),
    });
    const elsewhere = await insertConversation(user, {
      lastMessageAt: new Date("2026-10-09T10:00:00Z"),
    });

    const inside = await client.conversation.list({ projectId });
    const main = await client.conversation.list({});

    expect(inside.items.map((item) => item.id)).toEqual([inProject.id]);
    expect(main.items.map((item) => item.id)).toEqual([elsewhere.id]);
  });

  it("pages a Project's Conversations with the same cursor rules as the main list", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    await getTestDb()
      .insert(conversation)
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          id: uuidv7(),
          userId: user.id,
          model: "openai:gpt-5.6",
          projectId,
          lastMessageAt: new Date(Date.UTC(2026, 9, 1, 9, i)),
        })),
      );

    const first = await client.conversation.list({ projectId });
    const second = await client.conversation.list({
      projectId,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
  });

  it("answers NOT_FOUND for another user's Project", async () => {
    const other = await insertUser();
    const { id: projectId } = await chatRpc({ user: other }).project.create({ name: "Theirs" });
    const { client } = await signedIn();

    await expect(client.conversation.list({ projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("project.conversationCount", () => {
  it("counts the Project's Conversations, and leaves out other Conversations", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    await insertConversation(user, { projectId });
    await insertConversation(user, { projectId });
    await insertConversation(user, { title: "Loose" });

    await expect(client.project.conversationCount({ id: projectId })).resolves.toEqual({
      count: 2,
    });
  });

  it("answers NOT_FOUND for another user's Project", async () => {
    const other = await insertUser();
    const { id: projectId } = await chatRpc({ user: other }).project.create({ name: "Theirs" });
    const { client } = await signedIn();

    await expect(client.project.conversationCount({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("project.delete", () => {
  it("deletes the Project with its Conversations, Messages and Shared links, and answers the count", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Work" });
    const inProject = await insertConversation(user, { projectId });
    const question = await insertMessage({
      conversationId: inProject.id,
      role: "user",
      text: "Hi",
    });
    await insertMessage({
      conversationId: inProject.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });
    const link = await client.share.upsert({ conversationId: inProject.id });
    const loose = await insertConversation(user, { title: "Loose" });

    await expect(client.project.delete({ id: projectId })).resolves.toEqual({ count: 1 });

    await expect(client.project.get({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, inProject.id)),
    ).toEqual([]);
    expect(
      await getTestDb().select().from(message).where(eq(message.conversationId, inProject.id)),
    ).toEqual([]);
    await expect(client.share.get({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, loose.id)),
    ).toHaveLength(1);
  });

  it("answers NOT_FOUND for another user's Project, and leaves their Conversations alone", async () => {
    const other = await insertUser();
    const otherClient = chatRpc({ user: other });
    const { id: projectId } = await otherClient.project.create({ name: "Theirs" });
    const theirs = await insertConversation(other, { projectId });
    const { client } = await signedIn();

    await expect(client.project.delete({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, theirs.id)),
    ).toHaveLength(1);
  });

  describe("a live Run", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is stopped before its rows go, and writes nothing after", async () => {
      const { user, client } = await signedIn();
      const { id: projectId } = await client.project.create({ name: "Work" });
      const conv = await insertConversation(user, { projectId });
      const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
      await saveCredentials(createTestDeps(), user.id, {
        service: "anthropic",
        fields: { apiKey: "sk-ant-test-key" },
        hint: "…-key",
        verified: true,
      });
      // Held until the test releases it, so the Run is still live when the Project is deleted.
      const fake = createFakeAdapter({ rounds: [text("Hel", "lo")], manual: true });
      const deps = createTestDeps({ adapterFor: () => fake.adapter });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const chat = createTestChat({ user, deps });
      const started = await chat.fetch(
        new Request(chat.chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [],
            forwardedProps: {
              conversationId: conv.id,
              parentId: question.id,
              attachmentIds: [],
              model: "anthropic:claude-sonnet-5-5",
              webSearch: false,
            },
          }),
        }),
      );
      expect(started.status).toBe(200);
      const [reply] = await getTestDb()
        .select()
        .from(message)
        .where(and(eq(message.conversationId, conv.id), eq(message.status, "streaming")));
      if (!reply) throw new Error("The Run did not start a streaming Message");

      await expect(chat.rpc.project.delete({ id: projectId })).resolves.toEqual({ count: 1 });
      await fake.release(1);

      // The log ends with a terminal chunk, so a reader does not reconnect and start the Run again.
      const chunks = [];
      for await (const entry of deps.runStreams.read(reply.id, START)) chunks.push(entry.chunk);
      expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      // The owner's last writes landed on deleted rows, so no Message came back and nothing failed.
      expect(await getTestDb().select().from(message).where(eq(message.id, reply.id))).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});

describe("project.update Instructions", () => {
  async function withOpenAiCredentials() {
    const { user, client } = await signedIn();
    await saveCredentials(createTestDeps(), user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    return { user, client };
  }

  it("stores the Instructions, trimmed, and returns them from project.get", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });

    await client.project.update({ id, name: "Thesis", instructions: "  Cite sources.  " });

    await expect(client.project.get({ id })).resolves.toMatchObject({
      instructions: "Cite sources.",
    });
  });

  it("treats blank Instructions as none, and keeps the stored ones when left out", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });
    await client.project.update({ id, name: "Thesis", instructions: "Cite sources." });

    await client.project.update({ id, name: "Renamed" });
    await expect(client.project.get({ id })).resolves.toMatchObject({
      instructions: "Cite sources.",
    });

    await client.project.update({ id, name: "Renamed", instructions: "   \n " });
    await expect(client.project.get({ id })).resolves.toMatchObject({ instructions: null });
  });

  it("refuses Instructions over 4,000 characters and keeps the stored ones", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });
    await client.project.update({ id, name: "Thesis", instructions: "Cite sources." });

    await expect(
      client.project.update({ id, name: "Thesis", instructions: "x".repeat(4_001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.project.get({ id })).resolves.toMatchObject({
      instructions: "Cite sources.",
    });
  });

  it("accepts exactly 4,000 characters", async () => {
    const { client } = await withOpenAiCredentials();
    const { id } = await client.project.create({ name: "Thesis" });

    await expect(
      client.project.update({ id, name: "Thesis", instructions: "x".repeat(4_000) }),
    ).resolves.toBeUndefined();
  });
});
