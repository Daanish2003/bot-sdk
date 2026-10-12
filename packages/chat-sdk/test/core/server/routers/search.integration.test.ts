import { describe, expect, it } from "vitest";

import { insertConversation, insertMessage } from "../../../support/conversations";
import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user }) };
}

/** A minute after a fixed start, so ordering doesn't depend on the database clock. */
function at(minute: number) {
  return new Date(Date.UTC(2026, 9, 1, 12, minute));
}

describe("search.query", () => {
  it("finds Messages on every Branch, newest first, one row per Message", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user, { title: "Trip planning" });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Where should I go in Lisbon?",
      createdAt: at(1),
    });
    const inactive = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Lisbon has Alfama and Belém.",
      createdAt: at(2),
    });
    const active = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Try LISBON's Bairro Alto.",
      createdAt: at(3),
      active: true,
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: active.id,
      role: "user",
      text: "Thanks!",
      createdAt: at(4),
    });

    const result = await client.search.query({ q: "lisbon" });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([active.id, inactive.id, question.id]);
    expect(result.hits[0]).toEqual({
      messageId: active.id,
      conversationId: conv.id,
      conversationTitle: "Trip planning",
      role: "assistant",
      createdAt: at(3),
      snippet: { text: "Try LISBON's Bairro Alto.", match: { start: 4, end: 10 } },
    });
    expect(result.nextCursor).toBeNull();
  });

  it("opening a hit on an inactive Branch shows the newest leaf below it", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const hit = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "An answer about otters",
      createdAt: at(1),
    });
    const followUp = await insertMessage({
      conversationId: conv.id,
      parentId: hit.id,
      role: "user",
      text: "More please",
      createdAt: at(2),
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Another answer",
      createdAt: at(3),
      active: true,
    });

    const [found] = (await client.search.query({ q: "otters" })).hits;
    await client.conversation.switchBranch({ messageId: found!.messageId });

    const { messages } = await client.conversation.get({ id: conv.id });
    expect(messages.map((m) => m.id)).toEqual([question.id, hit.id, followUp.id]);
  });

  it("never returns another user's Messages", async () => {
    const { client } = await signedIn();
    const other = await insertUser();
    const theirs = await insertConversation(other);
    await insertMessage({ conversationId: theirs.id, role: "user", text: "secret plans" });

    await expect(client.search.query({ q: "secret" })).resolves.toEqual({
      hits: [],
      nextCursor: null,
    });
  });

  it("matches `%`, `_` and `\\` literally", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const literal = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: String.raw`50% off_ C:\temp`,
    });
    await insertMessage({ conversationId: conv.id, role: "user", text: "500 offers" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "offXline" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "C:/temp" });

    for (const q of ["0%", "off_", String.raw`:\t`]) {
      const result = await client.search.query({ q });
      expect(
        result.hits.map((hit) => hit.messageId),
        q,
      ).toEqual([literal.id]);
    }
  });

  it("refuses queries shorter than 2 characters", async () => {
    const { client } = await signedIn();

    await expect(client.search.query({ q: " a " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("pages through hits with a cursor", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const ids: string[] = [];
    for (let minute = 0; minute < 55; minute++) {
      const row = await insertMessage({
        conversationId: conv.id,
        role: "user",
        text: `note ${minute}`,
        createdAt: at(minute),
      });
      ids.unshift(row.id);
    }

    const first = await client.search.query({ q: "note" });
    expect(first.hits.map((hit) => hit.messageId)).toEqual(ids.slice(0, 50));
    expect(first.nextCursor).not.toBeNull();

    const second = await client.search.query({ q: "note", cursor: first.nextCursor! });
    expect(second.hits.map((hit) => hit.messageId)).toEqual(ids.slice(50));
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor it didn't write", async () => {
    const { client } = await signedIn();

    await expect(client.search.query({ q: "note", cursor: "garbage" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("requires a signed-in user", async () => {
    await expect(chatRpc().search.query({ q: "anything" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("search.query filters", () => {
  const sonnet = "anthropic:claude-sonnet-5-5";
  const gpt = "openai:gpt-5";

  it("Model matches the Model that wrote each assistant Message, never user Messages", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "lisbon question",
      createdAt: at(1),
    });
    const fromSonnet = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "lisbon answer A",
      model: sonnet,
      createdAt: at(2),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "lisbon answer B",
      model: gpt,
      createdAt: at(3),
    });

    const result = await client.search.query({ q: "lisbon", model: sonnet });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([fromSonnet.id]);
  });

  it("Provider matches the Provider part of the Model that wrote each assistant Message", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "tides note",
      createdAt: at(1),
    });
    const anthropicReply = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "tides reply",
      model: sonnet,
      createdAt: at(2),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "tides reply from openai",
      model: gpt,
      createdAt: at(3),
    });

    const result = await client.search.query({ q: "tides", provider: "anthropic" });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([anthropicReply.id]);
  });

  it("the date range is from-inclusive and to-exclusive, over every Message's date", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const before = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "river before",
      createdAt: at(0),
    });
    const first = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "river first",
      createdAt: at(1),
    });
    const second = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "river second",
      createdAt: at(2),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "river after",
      createdAt: at(3),
    });

    const result = await client.search.query({
      q: "river",
      from: at(1).toISOString(),
      to: at(3).toISOString(),
    });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([second.id, first.id]);
    expect(result.hits.map((hit) => hit.messageId)).not.toContain(before.id);
  });

  it("filters combine with each other and with the text (AND)", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const match = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "cloud pricing",
      model: sonnet,
      createdAt: at(5),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "cloud notes",
      model: gpt,
      createdAt: at(5),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "cloud old",
      model: sonnet,
      createdAt: at(0),
    });
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "rain pricing",
      model: sonnet,
      createdAt: at(5),
    });

    const result = await client.search.query({
      q: "cloud",
      model: sonnet,
      provider: "anthropic",
      from: at(4).toISOString(),
      to: at(6).toISOString(),
    });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([match.id]);
  });

  it("pages a filtered result set past 50 hits with no duplicates or gaps", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const ids: string[] = [];
    for (let minute = 0; minute < 55; minute++) {
      const row = await insertMessage({
        conversationId: conv.id,
        role: "assistant",
        text: `filtered ${minute}`,
        model: sonnet,
        createdAt: at(minute),
      });
      ids.unshift(row.id);
      await insertMessage({
        conversationId: conv.id,
        role: "assistant",
        text: `filtered other ${minute}`,
        model: gpt,
        createdAt: at(minute),
      });
    }
    const filter = { q: "filtered", model: sonnet };

    const first = await client.search.query(filter);
    expect(first.hits.map((hit) => hit.messageId)).toEqual(ids.slice(0, 50));
    const second = await client.search.query({ ...filter, cursor: first.nextCursor! });
    expect(second.hits.map((hit) => hit.messageId)).toEqual(ids.slice(50));
    expect(second.nextCursor).toBeNull();
  });

  it("a filter matching nothing returns an empty page, not an error", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    await insertMessage({ conversationId: conv.id, role: "user", text: "anything here" });

    await expect(client.search.query({ q: "anything", provider: "openai" })).resolves.toEqual({
      hits: [],
      nextCursor: null,
    });
  });

  it("refuses a filtered query shorter than 2 characters and a malformed date", async () => {
    const { client } = await signedIn();

    await expect(client.search.query({ q: "a", model: sonnet })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.search.query({ q: "note", from: "last tuesday" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("search.query Project filter", () => {
  it("returns only Messages from the Project's Conversations, combined with the other filters", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Thesis" });
    const { id: otherProjectId } = await client.project.create({ name: "Other" });
    const inProject = await insertConversation(user, { projectId });
    const inOther = await insertConversation(user, { projectId: otherProjectId });
    const loose = await insertConversation(user);
    const match = await insertMessage({
      conversationId: inProject.id,
      role: "assistant",
      text: "thesis outline",
      model: "anthropic:claude-sonnet-5-5",
      createdAt: at(5),
    });
    const notes = await insertMessage({
      conversationId: inProject.id,
      role: "assistant",
      text: "thesis notes",
      model: "openai:gpt-5",
      createdAt: at(3),
    });
    await insertMessage({
      conversationId: inOther.id,
      role: "assistant",
      text: "thesis elsewhere",
      model: "anthropic:claude-sonnet-5-5",
      createdAt: at(5),
    });
    await insertMessage({
      conversationId: loose.id,
      role: "assistant",
      text: "thesis loose",
      model: "anthropic:claude-sonnet-5-5",
      createdAt: at(5),
    });

    const byProject = await client.search.query({ q: "thesis", projectId });
    expect(byProject.hits.map((hit) => hit.messageId)).toEqual([match.id, notes.id]);

    const combined = await client.search.query({
      q: "thesis",
      projectId,
      model: "anthropic:claude-sonnet-5-5",
      provider: "anthropic",
      from: at(4).toISOString(),
      to: at(6).toISOString(),
    });
    expect(combined.hits.map((hit) => hit.messageId)).toEqual([match.id]);
  });

  it("pages a Project-filtered result set past 50 hits with no duplicates or gaps", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Long" });
    const inProject = await insertConversation(user, { projectId });
    const loose = await insertConversation(user);
    const ids: string[] = [];
    for (let minute = 0; minute < 55; minute++) {
      const row = await insertMessage({
        conversationId: inProject.id,
        role: "user",
        text: `project note ${minute}`,
        createdAt: at(minute),
      });
      ids.unshift(row.id);
      await insertMessage({
        conversationId: loose.id,
        role: "user",
        text: `project note loose ${minute}`,
        createdAt: at(minute),
      });
    }

    const first = await client.search.query({ q: "project note", projectId });
    expect(first.hits.map((hit) => hit.messageId)).toEqual(ids.slice(0, 50));
    const second = await client.search.query({
      q: "project note",
      projectId,
      cursor: first.nextCursor!,
    });
    expect(second.hits.map((hit) => hit.messageId)).toEqual(ids.slice(50));
    expect(second.nextCursor).toBeNull();
  });

  it("without the filter, Messages in Project Conversations are still found", async () => {
    const { user, client } = await signedIn();
    const { id: projectId } = await client.project.create({ name: "Hidden" });
    const inProject = await insertConversation(user, { projectId });
    const message1 = await insertMessage({
      conversationId: inProject.id,
      role: "user",
      text: "kelp forest survey",
    });

    const result = await client.search.query({ q: "kelp" });

    expect(result.hits.map((hit) => hit.messageId)).toEqual([message1.id]);
  });

  it("another user's Project id yields an empty page", async () => {
    const { client } = await signedIn();
    const other = await insertUser();
    const { id: theirProjectId } = await chatRpc({ user: other }).project.create({
      name: "Theirs",
    });
    const theirs = await insertConversation(other, { projectId: theirProjectId });
    await insertMessage({ conversationId: theirs.id, role: "user", text: "secret plans" });

    await expect(client.search.query({ q: "secret", projectId: theirProjectId })).resolves.toEqual({
      hits: [],
      nextCursor: null,
    });
  });
});
