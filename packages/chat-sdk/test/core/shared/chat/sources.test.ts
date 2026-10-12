import type { MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { replySegments, sourcesOf } from "../../../../core/shared/chat/sources";

const result = (n: number, url = `https://example.com/${n}`) => ({
  title: `Result ${n}`,
  url,
  snippet: `Snippet ${n}`,
});

/** A finished `web_search` call as `useChat` (or `toUIParts`) holds it. */
const searchPart = (id: string, query: string, results: ReturnType<typeof result>[]) =>
  ({
    type: "tool-call",
    id,
    name: "web_search",
    arguments: JSON.stringify({ query }),
    input: { query },
    state: "input-complete",
    output: { results },
  }) as MessagePart;

const textPart = (content: string): MessagePart => ({ type: "text", content });

describe("sourcesOf", () => {
  it("numbers a reply's Sources by first appearance across its searches, deduped by URL", () => {
    const parts = [
      searchPart("call-1", "one", [result(1), result(2)]),
      textPart("Some text."),
      searchPart("call-2", "two", [result(2), result(3), result(1)]),
    ];

    expect(sourcesOf(parts)).toEqual([
      { number: 1, url: "https://example.com/1", title: "Result 1", snippet: "Snippet 1" },
      { number: 2, url: "https://example.com/2", title: "Result 2", snippet: "Snippet 2" },
      { number: 3, url: "https://example.com/3", title: "Result 3", snippet: "Snippet 3" },
    ]);
  });

  it("treats URLs differing only by a fragment or trailing slash as one Source", () => {
    const parts = [
      searchPart("call-1", "one", [
        result(1, "https://example.com/docs/"),
        result(2, "https://example.com/docs#intro"),
      ]),
    ];

    expect(sourcesOf(parts).map((source) => source.number)).toEqual([1]);
  });

  it("has no Sources without a finished search", () => {
    expect(sourcesOf([textPart("Hi")])).toEqual([]);
    expect(
      sourcesOf([
        {
          type: "tool-call",
          id: "call-1",
          name: "web_search",
          arguments: '{"query":"q"}',
          state: "input-complete",
        },
      ]),
    ).toEqual([]);
  });
});

describe("replySegments", () => {
  it("merges back-to-back searches into one segment", () => {
    const segments = replySegments([
      textPart("Let me look."),
      searchPart("call-1", "one", [result(1)]),
      searchPart("call-2", "two", [result(2)]),
      searchPart("call-3", "three", [result(3)]),
      textPart("Found it."),
    ]);

    expect(segments).toMatchObject([
      { type: "text", content: "Let me look." },
      {
        type: "searches",
        searches: [{ query: "one" }, { query: "two" }, { query: "three" }],
      },
      { type: "text", content: "Found it." },
    ]);
  });

  it("gives a search separated by text its own segment", () => {
    const segments = replySegments([
      searchPart("call-1", "one", [result(1)]),
      textPart("Hmm."),
      searchPart("call-2", "two", [result(2)]),
    ]);

    expect(segments).toMatchObject([
      { type: "searches", searches: [{ query: "one" }] },
      { type: "text", content: "Hmm." },
      { type: "searches", searches: [{ query: "two" }] },
    ]);
  });

  it("doesn't let empty text or thinking separate searches", () => {
    const segments = replySegments([
      searchPart("call-1", "one", [result(1)]),
      textPart(""),
      { type: "thinking", content: "More?" },
      searchPart("call-2", "two", [result(2)]),
    ]);

    expect(segments).toMatchObject([
      { type: "searches", searches: [{ query: "one" }, { query: "two" }] },
    ]);
  });

  it("keys each segment by its position-independent first part", () => {
    const segments = replySegments([searchPart("call-1", "one", [result(1)]), textPart("Text.")]);

    expect(segments.map((segment) => segment.key)).toEqual(["call-1", "text-1"]);
  });
});

/** A finished `fetch_url` call as `useChat` (or `toUIParts`) holds it, with the page it read. */
const fetchPart = (id: string, url: string, content = "Page text.") =>
  ({
    type: "tool-call",
    id,
    name: "fetch_url",
    arguments: JSON.stringify({ url }),
    input: { url },
    state: "complete",
    output: { url, title: "Page", content },
    metadata: { source: "builtin", status: "done" },
  }) as MessagePart;

describe("sourcesOf with fetched pages", () => {
  it("numbers a fetched page with the search results, in stream order, deduped by URL", () => {
    const parts = [
      fetchPart("call-1", "https://example.com/page/"),
      searchPart("call-2", "two", [result(1), result(2, "https://example.com/page")]),
      textPart("Text."),
    ];

    expect(sourcesOf(parts)).toEqual([
      { number: 1, url: "https://example.com/page/", title: "Page", snippet: "Page text." },
      { number: 2, url: "https://example.com/1", title: "Result 1", snippet: "Snippet 1" },
    ]);
  });

  it("gives a fetch that read no page no Source", () => {
    const failed = {
      ...fetchPart("call-1", "https://example.com/pdf"),
      output: { error: "unsupported", reason: "unsupported" },
    } as MessagePart;

    expect(sourcesOf([failed])).toEqual([]);
  });

  it("keeps a page's first 200 characters as its snippet", () => {
    const [source] = sourcesOf([
      fetchPart("call-1", "https://example.com/long", "word ".repeat(100)),
    ]);

    expect(source!.snippet.length).toBeLessThanOrEqual(201);
    expect(source!.snippet.endsWith("…")).toBe(true);
  });
});
