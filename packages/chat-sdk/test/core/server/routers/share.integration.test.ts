import { storedParts } from "../../../../core/shared/message-parts";
import { describe, expect, it } from "vitest";

import { citationFor } from "../../../../core/shared/chat/citations";
import { replySegments, sourcesOf } from "../../../../core/shared/chat/sources";
import { insertAttachment, linkTestAttachments } from "../../../support/attachments";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user }) };
}

/** A titled Conversation whose Active Branch is a question and a complete reply. */
async function answeredConversation() {
  const { user, client } = await signedIn();
  const conv = await insertConversation(user, { title: "Recursive CTEs" });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
  const reply = await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "Hello!",
    active: true,
  });
  return { user, client, conv, question, reply };
}

describe("share.upsert", () => {
  it("creates a link to the Active Branch that anyone can open", async () => {
    const { client, conv, question, reply } = await answeredConversation();

    const link = await client.share.upsert({ conversationId: conv.id });

    expect(link.token).toMatch(/^[\w-]{22}$/);
    const shared = await chatRpc().share.get({ token: link.token });
    expect(shared).toEqual({
      token: link.token,
      title: "Recursive CTEs",
      sharedAt: link.updatedAt,
      messages: [
        {
          id: question.id,
          role: "user",
          parts: [{ type: "text", content: "Hi" }],
          attachments: [],
          model: null,
          status: "complete",
          createdAt: question.createdAt,
        },
        {
          id: reply.id,
          role: "assistant",
          parts: [{ type: "text", content: "Hello!" }],
          attachments: [],
          model: "anthropic:claude-sonnet-5-5",
          status: "complete",
          createdAt: reply.createdAt,
        },
      ],
    });
  });

  it("freezes the title, falling back to Untitled", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });

    const link = await client.share.upsert({ conversationId: conv.id });
    await client.conversation.rename({ id: conv.id, title: "Renamed later" });

    await expect(chatRpc().share.get({ token: link.token })).resolves.toMatchObject({
      title: "Untitled",
    });
  });

  it("re-points the same link at the current Branch and refreshes the title", async () => {
    const { client, conv, question } = await answeredConversation();
    const first = await client.share.upsert({ conversationId: conv.id });
    const newer = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "A regenerated reply",
      active: true,
    });
    await client.conversation.rename({ id: conv.id, title: "New title" });

    const second = await client.share.upsert({ conversationId: conv.id });

    expect(second.token).toBe(first.token);
    const shared = await chatRpc().share.get({ token: first.token });
    expect(shared.title).toBe("New title");
    expect(shared.messages.map((m) => m.id)).toEqual([question.id, newer.id]);
  });

  it.each(["streaming", "error"] as const)(
    "refuses while the newest Message is %s",
    async (status) => {
      const { user, client } = await signedIn();
      const conv = await insertConversation(user);
      const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
      await insertMessage({
        conversationId: conv.id,
        parentId: question.id,
        role: "assistant",
        text: "Partial",
        status,
        active: true,
      });

      await expect(client.share.upsert({ conversationId: conv.id })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    },
  );

  it("refuses to update an existing link while a reply is streaming, keeping the old one", async () => {
    const { client, conv, reply } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });
    await insertMessage({
      conversationId: conv.id,
      parentId: reply.id,
      role: "user",
      text: "More",
      status: "streaming",
      active: true,
    });

    await expect(client.share.upsert({ conversationId: conv.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const shared = await chatRpc().share.get({ token: link.token });
    expect(shared.messages.at(-1)?.id).toBe(reply.id);
  });

  it("shares a stopped reply", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Partial",
      status: "stopped",
      active: true,
    });

    const link = await client.share.upsert({ conversationId: conv.id });

    await expect(chatRpc().share.get({ token: link.token })).resolves.toMatchObject({
      messages: [{ status: "complete" }, { status: "stopped" }],
    });
  });

  it("refuses an empty Conversation", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);

    await expect(client.share.upsert({ conversationId: conv.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("can't share another user's Conversation", async () => {
    const { conv } = await answeredConversation();
    const other = await signedIn();

    await expect(other.client.share.upsert({ conversationId: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("share.list", () => {
  it("lists only the caller's links, with token, Conversation, current title and share date", async () => {
    const { client, conv } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });
    await client.conversation.rename({ id: conv.id, title: "Renamed after sharing" });

    await expect(client.share.list()).resolves.toEqual([
      {
        token: link.token,
        conversationId: conv.id,
        title: "Renamed after sharing",
        sharedAt: link.updatedAt,
      },
    ]);
  });

  it("never lists another user's links", async () => {
    const { client, conv } = await answeredConversation();
    await client.share.upsert({ conversationId: conv.id });
    const other = await signedIn();

    await expect(other.client.share.list()).resolves.toEqual([]);
  });

  it("is empty for a user with no links", async () => {
    const { client } = await signedIn();

    await expect(client.share.list()).resolves.toEqual([]);
  });

  it("is refused to signed-out callers", async () => {
    await expect(chatRpc().share.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("share.forConversation", () => {
  it("has no link before the Conversation is shared", async () => {
    const { client, conv } = await answeredConversation();

    await expect(client.share.forConversation({ conversationId: conv.id })).resolves.toEqual({
      link: null,
      movedOn: false,
      blockedBy: null,
    });
  });

  it("returns the link and whether the Conversation has moved on since", async () => {
    const { client, conv, reply } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });

    await expect(client.share.forConversation({ conversationId: conv.id })).resolves.toEqual({
      link,
      movedOn: false,
      blockedBy: null,
    });

    await insertMessage({
      conversationId: conv.id,
      parentId: reply.id,
      role: "user",
      text: "One more thing",
      active: true,
    });

    await expect(client.share.forConversation({ conversationId: conv.id })).resolves.toEqual({
      link,
      movedOn: true,
      blockedBy: null,
    });
  });

  it("says why sharing is blocked", async () => {
    const { user, client } = await signedIn();
    const empty = await insertConversation(user);
    const failed = await insertConversation(user);
    await insertMessage({
      conversationId: failed.id,
      role: "assistant",
      text: "",
      status: "error",
      active: true,
    });

    await expect(client.share.forConversation({ conversationId: empty.id })).resolves.toMatchObject(
      { blockedBy: "empty" },
    );
    await expect(
      client.share.forConversation({ conversationId: failed.id }),
    ).resolves.toMatchObject({ blockedBy: "error" });
  });

  it("hides another user's Conversation", async () => {
    const { conv } = await answeredConversation();
    const other = await signedIn();

    await expect(
      other.client.share.forConversation({ conversationId: conv.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("share.delete", () => {
  it("deletes the link, after which its token is not found", async () => {
    const { client, conv } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });

    await client.share.delete({ conversationId: conv.id });

    await expect(chatRpc().share.get({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.share.forConversation({ conversationId: conv.id })).resolves.toMatchObject({
      link: null,
    });
  });

  it("drops the link from the caller's list, and its token stops answering", async () => {
    const { client, conv } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });

    await client.share.delete({ conversationId: conv.id });

    await expect(client.share.list()).resolves.toEqual([]);
    await expect(chatRpc().share.get({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("can't delete another user's link", async () => {
    const { client, conv } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });
    const other = await signedIn();

    await expect(other.client.share.delete({ conversationId: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(chatRpc().share.get({ token: link.token })).resolves.toMatchObject({
      title: "Recursive CTEs",
    });
  });
});

describe("share.get", () => {
  it("answers NOT_FOUND for an unknown token", async () => {
    await expect(chatRpc().share.get({ token: "AAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never shows a reply's thinking", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      parts: storedParts([
        { type: "thinking", text: "Private musing.", signature: "sig-1" },
        { type: "text", text: "Hello!" },
      ]),
      active: true,
    });

    const link = await client.share.upsert({ conversationId: conv.id });
    const shared = await chatRpc().share.get({ token: link.token });

    expect(shared.messages[1]?.parts).toEqual([{ type: "text", content: "Hello!" }]);
    expect(JSON.stringify(shared)).not.toContain("Private musing");
  });

  it("shows attachments as filename-and-type chips, never their bytes", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const secret = "Top secret file contents";
    const notes = await insertAttachment(user, { filename: "notes.txt", contents: secret });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Summarise",
      active: true,
    });
    await linkTestAttachments(question.id, [notes.id]);

    const link = await client.share.upsert({ conversationId: conv.id });
    const shared = await chatRpc().share.get({ token: link.token });

    expect(shared.messages[0]?.attachments).toEqual([
      { filename: "notes.txt", mediaType: "text/plain" },
    ]);
    const json = JSON.stringify(shared);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(Buffer.from(secret).toString("base64"));
    expect(json).not.toContain(notes.id);
  });

  it("leaves out the error details of a failed reply earlier on the Branch", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const failed = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      status: "error",
      error: "401 invalid x-api-key",
      errorReason: "invalid_key",
    });
    const retry = await insertMessage({
      conversationId: conv.id,
      parentId: failed.id,
      role: "user",
      text: "Again",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: retry.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });

    const link = await client.share.upsert({ conversationId: conv.id });
    const shared = await chatRpc().share.get({ token: link.token });

    expect(shared.messages[1]).toEqual({
      id: failed.id,
      role: "assistant",
      parts: [],
      attachments: [],
      model: "anthropic:claude-sonnet-5-5",
      status: "error",
      createdAt: failed.createdAt,
    });
  });

  it("carries a reply's searches and cited links, so the page shows its Sources and citations", async () => {
    const { user, client } = await signedIn();
    const conv = await insertConversation(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "News?" });
    const docs = { title: "TanStack AI", url: "https://tanstack.com/ai", snippet: "Docs" };
    const blog = { title: "Blog", url: "https://example.com/blog", snippet: "Post" };
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([
        {
          type: "web_search",
          toolCallId: "call-1",
          query: "tanstack ai",
          state: "done",
          results: [docs, blog],
        },
        { type: "text", text: "It has lazy tools ([tanstack.com](https://tanstack.com/ai))." },
      ]),
      active: true,
    });

    const link = await client.share.upsert({ conversationId: conv.id });
    const shared = await chatRpc().share.get({ token: link.token });
    const parts = shared.messages[1]!.parts;

    const sources = sourcesOf(parts);
    expect(sources).toEqual([
      { number: 1, ...docs },
      { number: 2, ...blog },
    ]);
    expect(replySegments(parts)).toMatchObject([
      { type: "searches", searches: [{ query: "tanstack ai", state: "done" }] },
      { type: "text", content: "It has lazy tools ([tanstack.com](https://tanstack.com/ai))." },
    ]);
    expect(citationFor("https://tanstack.com/ai", sources)?.number).toBe(1);
  });
});

describe("deleting what a link points at", () => {
  it("deletes the link along with its Conversation", async () => {
    const { client, conv } = await answeredConversation();
    const link = await client.share.upsert({ conversationId: conv.id });

    await client.conversation.delete({ id: conv.id });

    await expect(chatRpc().share.get({ token: link.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("signed-out callers", () => {
  it("can't create, read or delete a Conversation's link", async () => {
    const client = chatRpc();
    const conversationId = "0190a000-0000-7000-8000-000000000000";

    await expect(client.share.upsert({ conversationId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.share.forConversation({ conversationId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.share.delete({ conversationId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
