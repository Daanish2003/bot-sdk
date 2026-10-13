import type { MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  type ExportMessage,
  renderConversationMarkdown,
} from "../../../core/server/export-markdown";

const exportedAt = new Date("2026-10-13T09:30:00Z");

function assistant(parts: MessagePart[], overrides: Partial<ExportMessage> = {}): ExportMessage {
  return {
    role: "assistant",
    parts,
    attachments: [],
    model: "anthropic:claude-sonnet-5-5",
    status: "complete",
    error: null,
    errorReason: null,
    ...overrides,
  };
}

function user(text: string, overrides: Partial<ExportMessage> = {}): ExportMessage {
  return {
    role: "user",
    parts: [{ type: "text", content: text }],
    attachments: [],
    model: null,
    status: "complete",
    error: null,
    errorReason: null,
    ...overrides,
  };
}

const text = (content: string): MessagePart => ({ type: "text", content });

function toolCall(
  name: string,
  metadata: Record<string, unknown> = { source: "builtin", status: "done" },
  output: unknown = {},
): MessagePart {
  return {
    type: "tool-call",
    id: `call-${name}`,
    name,
    arguments: "{}",
    input: {},
    state: "complete",
    output,
    metadata,
  } as MessagePart;
}

describe("renderConversationMarkdown", () => {
  it("starts with the title and the export date, then each Message under its heading", () => {
    const { markdown } = renderConversationMarkdown({
      title: "Trip plan",
      exportedAt,
      messages: [user("Plan a trip"), assistant([text("Sure, where?")])],
    });

    expect(markdown).toBe(
      [
        "# Trip plan",
        "",
        "Exported 2026-10-13",
        "",
        "---",
        "",
        "## You",
        "",
        "Plan a trip",
        "",
        "---",
        "",
        "## Assistant · Claude Sonnet 5.5",
        "",
        "Sure, where?",
        "",
      ].join("\n"),
    );
  });

  it("titles an untitled Conversation 'Untitled Conversation'", () => {
    const { markdown } = renderConversationMarkdown({ title: null, exportedAt, messages: [] });

    expect(markdown.startsWith("# Untitled Conversation\n\nExported 2026-10-13")).toBe(true);
  });

  it("writes an assistant Message without a Model as plain 'Assistant'", () => {
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [assistant([text("Hi")], { model: null })],
    });

    expect(markdown).toContain("## Assistant\n\nHi");
  });

  it("keeps reply text verbatim and leaves reasoning out", () => {
    const code = "```ts\nconst a = [1, 2];\n```\n\n- item *one*";
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [
        assistant([{ type: "thinking", content: "secret thoughts" } as MessagePart, text(code)]),
      ],
    });

    expect(markdown).toContain(code);
    expect(markdown).not.toContain("secret thoughts");
  });

  it("shows each tool call as one quote line, with denied and waiting calls marked", () => {
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [
        assistant([
          toolCall("web_search", undefined, { results: [] }),
          toolCall("fetch_url"),
          toolCall("lookup_issue", { source: "mcp", status: "denied" }),
          toolCall("create_pr", { source: "mcp", status: "awaiting_approval" }),
        ]),
      ],
    });

    expect(markdown).toContain("> Used web_search");
    expect(markdown).toContain("> Used fetch_url");
    expect(markdown).toContain("> Used lookup_issue (denied)");
    expect(markdown).toContain("> Waiting for Approval: create_pr");
  });

  it("numbers cited links as reference links and lists the Sources under the Message", () => {
    const search = {
      type: "tool-call",
      id: "s1",
      name: "web_search",
      arguments: "",
      input: { query: "tanstack" },
      state: "complete",
      output: {
        results: [
          { title: "TanStack", url: "https://tanstack.com/ai", snippet: "AI" },
          { title: "Other", url: "https://example.com/x", snippet: "Other" },
        ],
      },
    } as MessagePart;
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [
        assistant([
          search,
          text(
            "TanStack AI supports tools ([tanstack.com](https://tanstack.com/ai/)). See [docs](https://docs.example.org/) and ![img](https://example.com/x).",
          ),
        ]),
      ],
    });

    expect(markdown).toContain(
      "TanStack AI supports tools ([tanstack.com][1]). See [docs](https://docs.example.org/) and ![img](https://example.com/x).",
    );
    expect(markdown).toContain(
      '\n\n[1]: https://tanstack.com/ai "TanStack"\n[2]: https://example.com/x "Other"',
    );
  });

  it("leaves a link that cites a Source inside a code block as it is", () => {
    const search = {
      type: "tool-call",
      id: "s1",
      name: "web_search",
      arguments: "",
      input: { query: "q" },
      state: "complete",
      output: { results: [{ title: "T", url: "https://a.example/", snippet: "" }] },
    } as MessagePart;
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [assistant([search, text("```\n[a](https://a.example/)\n```")])],
    });

    expect(markdown).toContain("```\n[a](https://a.example/)\n```");
  });

  it("lists attachments by file name and type under the user Message", () => {
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [
        user("See attached", {
          attachments: [
            { id: "a1", filename: "report.pdf", mediaType: "application/pdf", size: 1 },
            { id: "a2", filename: "notes.txt", mediaType: "text/plain", size: 1 },
            { id: "a3", filename: "photo.png", mediaType: "image/png", size: 1 },
          ],
        }),
      ],
    });

    expect(markdown).toContain(
      "See attached\n\nAttachments: report.pdf (PDF), notes.txt (text), photo.png (image)",
    );
  });

  it("marks a stopped, failed or still-streaming reply", () => {
    const { markdown } = renderConversationMarkdown({
      title: "T",
      exportedAt,
      messages: [
        assistant([text("Half")], { status: "stopped" }),
        assistant([text("Oops")], { status: "error", error: "Provider timed out" }),
        assistant([text("Going")], { status: "streaming" }),
      ],
    });

    expect(markdown).toContain("Half\n\n_(Stopped)_");
    expect(markdown).toContain("Oops\n\n_(Failed: Provider timed out)_");
    expect(markdown).toContain("Going\n\n_(Still writing when exported)_");
  });

  it("names the file after the title, filesystem-safe and at most 80 characters", () => {
    const name = (title: string | null) =>
      renderConversationMarkdown({ title, exportedAt, messages: [] }).fileName;

    expect(name("Trip plan")).toBe("Trip plan.md");
    expect(name("a/b: what's *new*?")).toBe("ab whats new.md");
    expect(name(null)).toBe("conversation.md");
    expect(name("  !!!  ")).toBe("conversation.md");
    expect(name("x".repeat(120))).toBe(`${"x".repeat(80)}.md`);
  });
});
