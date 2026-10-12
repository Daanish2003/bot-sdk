import {
  type StoredPart,
  storedParts,
  type WebSearchPart,
} from "../../../../core/shared/message-parts";
import { EventType, type MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  cancelRunningCalls,
  createPartsBuilder,
  parseStoredParts,
  searchTextOf,
  toModelMessages,
  toUIParts,
} from "../../../../core/shared/chat/parts";
import { webSearchOf } from "../../../../core/shared/chat/web-search";

const result = (n: number) => ({
  title: `Result ${n}`,
  url: `https://example.com/${n}`,
  snippet: `Snippet ${n}`,
});

const search = (fields: Partial<WebSearchPart> = {}): WebSearchPart => ({
  type: "web_search",
  toolCallId: "call-1",
  query: "tanstack ai",
  state: "done",
  results: [result(1)],
  ...fields,
});

const text = (value: string): StoredPart => ({ type: "text", text: value });

describe("web searches in stored parts from a stream", () => {
  it("adds a running search in stream order and finishes it with its results", () => {
    const builder = createPartsBuilder();
    builder.add({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a",
      delta: "Let me look.",
      timestamp: 0,
    });

    builder.startSearch("call-1", "tanstack ai");
    expect(builder.parts().parts).toEqual([
      text("Let me look."),
      search({ state: "running", results: [] }),
    ]);

    builder.finishSearch("call-1", { results: [result(1)] });
    builder.add({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "b",
      delta: "Found it.",
      timestamp: 0,
    });
    expect(builder.parts().parts).toEqual([text("Let me look."), search(), text("Found it.")]);
  });

  it("finishes a failed search as error with its reason", () => {
    const builder = createPartsBuilder();
    builder.startSearch("call-1", "tanstack ai");

    builder.finishSearch("call-1", { errorReason: "quota_exhausted" });

    expect(builder.parts().parts).toEqual([
      search({ state: "error", results: [], errorReason: "quota_exhausted" }),
    ]);
  });

  it("closes a search still running as cancelled, and a cancelled search stays cancelled", () => {
    const builder = createPartsBuilder();
    builder.startSearch("call-1", "first");
    builder.finishSearch("call-1", { results: [result(1)] });
    builder.startSearch("call-2", "second");

    builder.cancelRunningCalls();
    builder.finishSearch("call-2", { results: [result(2)] });

    expect(builder.parts().parts).toEqual([
      search({ query: "first" }),
      search({ toolCallId: "call-2", query: "second", state: "cancelled", results: [] }),
    ]);
  });

  it("closes running searches in stored parts as cancelled", () => {
    const parts = storedParts([search({ state: "running", results: [] }), text("Hi"), search()]);

    expect(cancelRunningCalls(parts).parts).toEqual([
      search({ state: "cancelled", results: [] }),
      text("Hi"),
      search(),
    ]);
  });
});

describe("web searches to TanStack AI", () => {
  const history = [
    { role: "user" as const, parts: storedParts([text("What's new in TanStack AI?")]) },
    {
      role: "assistant" as const,
      parts: storedParts([
        text("Let me look."),
        search(),
        search({
          toolCallId: "call-2",
          query: "broken",
          state: "error",
          results: [],
          errorReason: "invalid_key",
        }),
        text("Lazy tools."),
      ]),
    },
  ];

  it("replays searches as tool calls and their results when the tool is offered", () => {
    expect(toModelMessages(history, { webSearch: true })).toEqual([
      { role: "user", content: "What's new in TanStack AI?" },
      {
        role: "assistant",
        content: "Let me look.",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"tanstack ai"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"broken"}' },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ results: [result(1)] }),
      },
      {
        role: "tool",
        toolCallId: "call-2",
        content: JSON.stringify({ error: "Tavily rejected the API key", reason: "invalid_key" }),
      },
      { role: "assistant", content: "Lazy tools." },
    ]);
  });

  it("drops searches that never got a result (running or cancelled)", () => {
    const unfinished = [
      {
        role: "assistant" as const,
        parts: storedParts([
          text("Looking."),
          search({ state: "cancelled", results: [] }),
          search({ toolCallId: "call-2", state: "running", results: [] }),
        ]),
      },
    ];

    expect(toModelMessages(unfinished, { webSearch: true })).toEqual([
      { role: "assistant", content: "Looking." },
    ]);
  });

  it("turns searches into a short text placeholder when the tool isn't offered", () => {
    expect(toModelMessages(history, { webSearch: false })).toEqual([
      { role: "user", content: "What's new in TanStack AI?" },
      {
        role: "assistant",
        content:
          'Let me look.\n\n[Searched the web for "tanstack ai": Result 1 (https://example.com/1)]\n\n' +
          '[Searched the web for "broken": the search failed]\n\nLazy tools.',
      },
    ]);
  });

  it("gives useChat each search as a web_search tool call that reads back unchanged", () => {
    const parts = storedParts([
      search({ state: "running", results: [] }),
      search({ toolCallId: "call-2" }),
      search({ toolCallId: "call-3", state: "error", results: [], errorReason: "quota_exhausted" }),
      search({ toolCallId: "call-4", state: "cancelled", results: [] }),
    ]);

    const uiParts = toUIParts(parts);

    expect(uiParts[1]).toEqual({
      type: "tool-call",
      id: "call-2",
      name: "web_search",
      arguments: '{"query":"tanstack ai"}',
      input: { query: "tanstack ai" },
      state: "complete",
      output: { results: [result(1)] },
    });
    expect(uiParts.map(webSearchOf)).toEqual(parts.parts);
  });

  it("reads a search that useChat is streaming", () => {
    const streaming: MessagePart = {
      type: "tool-call",
      id: "call-1",
      name: "web_search",
      arguments: '{"query":"tan',
      state: "input-streaming",
    };
    const limited: MessagePart = {
      type: "tool-call",
      id: "call-4",
      name: "web_search",
      arguments: '{"query":"more"}',
      input: { query: "more" },
      state: "complete",
      output: { error: "search limit reached" },
    };

    const asked: MessagePart = { ...streaming, arguments: '{"query":"tanstack ai"}' };

    // Not a search until its query has streamed in.
    expect(webSearchOf(streaming)).toBeNull();
    expect(webSearchOf(asked)).toEqual(search({ state: "running", results: [] }));
    // The 4th call never searched, so it isn't a search.
    expect(webSearchOf(limited)).toBeNull();
    expect(webSearchOf({ type: "text", content: "Hi" })).toBeNull();
  });

  it("leaves searches out of searchText", () => {
    expect(searchTextOf(storedParts([text("Hi"), search()]))).toBe("Hi");
  });

  it("reads a stored web_search part", () => {
    const json = {
      schemaVersion: 1,
      parts: [search({ results: [{ ...result(1), publishedDate: "2026-10-01" }] })],
    };

    expect(parseStoredParts(json)).toEqual(json);
    expect(() =>
      parseStoredParts({ schemaVersion: 1, parts: [search({ state: "pending" as "done" })] }),
    ).toThrow();
  });
});
