import { storedParts } from "../../../../plugins/assistant/shared/message-parts";
import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appRouter } from "../../../../plugins/assistant/server/routers/index";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, chatRpc } from "../../../support/assistant";
import { insertAttachment, linkTestAttachments } from "../../../support/attachments";
import { insertUser } from "../../../support/users";

const exportedAt = new Date("2026-10-13T09:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(exportedAt);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation.exportMarkdown", () => {
  it("exports the Active Branch of a Conversation as one Markdown document", async () => {
    const user = await insertUser();
    const client = chatRpc({ user });
    const conv = await insertConversation(user, { title: "Trip research" });
    const notes = await insertAttachment(user, { filename: "notes.txt", mediaType: "text/plain" });

    // A Branch off the Active path: an earlier reply to the first question, never exported.
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Summarize TanStack AI",
    });
    await linkTestAttachments(question.id, [notes.id]);
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "An abandoned reply",
    });
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([
        { type: "thinking", text: "private reasoning" },
        {
          type: "web_search",
          toolCallId: "search-1",
          query: "tanstack ai",
          state: "done",
          results: [
            { title: "TanStack AI", url: "https://tanstack.com/ai/latest", snippet: "AI" },
            { title: "Docs", url: "https://example.com/docs", snippet: "Docs" },
          ],
        },
        {
          type: "text",
          text: "TanStack AI supports tool calling ([tanstack.com](https://tanstack.com/ai/latest/)).",
        },
        {
          type: "tool_call",
          toolCallId: "fetch-1",
          name: "fetch_url",
          source: "builtin",
          args: { url: "https://example.com/docs" },
          state: "done",
          result: { url: "https://example.com/docs", title: "Docs", content: "Read" },
        },
        {
          type: "tool_call",
          toolCallId: "mcp-1",
          name: "create_issue",
          source: "mcp",
          args: {},
          state: "denied",
        },
        {
          type: "text",
          text: "```ts\nconst x = 1;\n```\n\nSee [a doc](https://example.com/docs#intro).",
        },
      ]),
      active: true,
    });
    const followUp = await insertMessage({
      conversationId: conv.id,
      parentId: reply.id,
      role: "user",
      text: "Now stop",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: followUp.id,
      role: "assistant",
      text: "Partial answer",
      status: "stopped",
      active: true,
    });

    const result = await client.conversation.exportMarkdown({ id: conv.id });

    expect(result.fileName).toBe("Trip research.md");
    expect(result.markdown).toBe(
      [
        "# Trip research",
        "",
        "Exported 2026-10-13",
        "",
        "---",
        "",
        "## You",
        "",
        "Summarize TanStack AI",
        "",
        "Attachments: notes.txt (text)",
        "",
        "---",
        "",
        "## Assistant · Claude Sonnet 5.5",
        "",
        "> Used web_search",
        "",
        "TanStack AI supports tool calling ([tanstack.com][1]).",
        "",
        "> Used fetch_url",
        "",
        "> Used create_issue (denied)",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "See [a doc][2].",
        "",
        '[1]: https://tanstack.com/ai/latest "TanStack AI"',
        '[2]: https://example.com/docs "Docs"',
        "",
        "---",
        "",
        "## You",
        "",
        "Now stop",
        "",
        "---",
        "",
        "## Assistant · Claude Sonnet 5.5",
        "",
        "Partial answer",
        "",
        "_(Stopped)_",
        "",
      ].join("\n"),
    );
  });

  it("names an untitled Conversation's file conversation.md and titles it so", async () => {
    const user = await insertUser();
    const client = chatRpc({ user });
    const conv = await insertConversation(user, { title: null });

    await expect(client.conversation.exportMarkdown({ id: conv.id })).resolves.toEqual({
      fileName: "conversation.md",
      markdown: "# Untitled Conversation\n\nExported 2026-10-13\n",
    });
  });

  it("is owner only: another user's Conversation, or an unknown one, is NOT_FOUND", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const conv = await insertConversation(owner, { title: "Private" });
    const deps = createTestSdk();
    const asStranger = chatRpc({ user: stranger, deps });

    await expect(
      chatRpc({ user: owner, deps }).conversation.exportMarkdown({ id: conv.id }),
    ).resolves.toMatchObject({ fileName: "Private.md" });
    await expect(asStranger.conversation.exportMarkdown({ id: conv.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      chatRpc({ user: owner, deps }).conversation.exportMarkdown({
        id: "0190f000-0000-7000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a signed-out caller", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Private" });
    const deps = createTestSdk();
    const signedOut = createRouterClient(appRouter, {
      context: { user: null, sdk: deps },
    });

    await expect(signedOut.conversation.exportMarkdown({ id: conv.id })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
