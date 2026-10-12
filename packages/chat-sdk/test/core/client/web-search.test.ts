import type { WebSearchPart } from "../../../core/shared/message-parts";
import { describe, expect, it } from "vitest";

import {
  describeSearch,
  describeSearches,
  domainOf,
  searchToggle,
} from "../../../core/client/web-search";

const search = (fields: Partial<WebSearchPart>): WebSearchPart => ({
  type: "web_search",
  toolCallId: "call-1",
  query: "tanstack ai",
  state: "done",
  results: [],
  ...fields,
});

const result = { title: "TanStack AI", url: "https://tanstack.com/ai", snippet: "…" };

describe("searchToggle (the Web toggle)", () => {
  it("is on with a Tavily key: search and fetch", () => {
    expect(searchToggle({ hasTavilyKey: true, modelTools: true, on: true })).toEqual({
      available: true,
      enabled: true,
      tooltip: "Web on: search and read pages",
    });
    expect(searchToggle({ hasTavilyKey: true, modelTools: true, on: false })).toMatchObject({
      enabled: false,
      tooltip: "Web off",
    });
  });

  it("without a Tavily key is still available: fetch only, and the tooltip says search needs a key", () => {
    expect(searchToggle({ hasTavilyKey: false, modelTools: true, on: true })).toEqual({
      available: true,
      enabled: true,
      tooltip: "Web on: reads pages you link. Search needs a Tavily key in Keys & settings",
    });
  });

  it("is unavailable, and explains why, for a Model without tools", () => {
    expect(searchToggle({ hasTavilyKey: true, modelTools: false, on: true })).toEqual({
      available: false,
      enabled: false,
      tooltip: "This Model can't use tools, so it can't use the web",
    });
  });
});

describe("describeSearch", () => {
  it("says what a search is doing or found", () => {
    expect(describeSearch(search({ state: "running" }))).toEqual({
      text: 'Searching the web for "tanstack ai"…',
      keySettings: false,
    });
    expect(describeSearch(search({ results: [result, result] }))).toEqual({
      text: 'Searched "tanstack ai" · 2 sources',
      keySettings: false,
    });
    expect(describeSearch(search({ results: [result] })).text).toBe(
      'Searched "tanstack ai" · 1 source',
    );
    expect(describeSearch(search({})).text).toBe('No results for "tanstack ai"');
    expect(describeSearch(search({ state: "cancelled" })).text).toBe("Search cancelled");
  });

  it("gives a failed search's reason, with Key settings for a rejected key", () => {
    expect(describeSearch(search({ state: "error", errorReason: "invalid_key" }))).toEqual({
      text: "Search failed: Tavily rejected your key.",
      keySettings: true,
    });
    expect(describeSearch(search({ state: "error", errorReason: "quota_exhausted" }))).toEqual({
      text: "Search failed: Tavily's monthly quota is used up.",
      keySettings: false,
    });
    expect(describeSearch(search({ state: "error", errorReason: "failed" })).text).toBe(
      "Search failed.",
    );
  });
});

describe("describeSearches", () => {
  const page = (n: number) => ({
    title: `Page ${n}`,
    url: `https://example.com/${n}`,
    snippet: "…",
  });

  it("reads like a single search's line for one search", () => {
    expect(describeSearches([search({ results: [result] })]).text).toBe(
      'Searched "tanstack ai" · 1 source',
    );
  });

  it("counts back-to-back searches and their distinct Sources", () => {
    expect(
      describeSearches([
        search({ query: "one", results: [page(1), page(2)] }),
        search({ query: "two", results: [page(2), page(3)] }),
        search({ query: "three", state: "error", errorReason: "failed" }),
      ]),
    ).toEqual({ text: "Searched 3 times · 3 sources", keySettings: false, failed: false });
    expect(describeSearches([search({}), search({ query: "two" })]).text).toBe(
      "Searched 2 times · no sources",
    );
  });

  it("shows the search still running, and Key settings when any key was rejected", () => {
    expect(
      describeSearches([
        search({ query: "one", state: "error", errorReason: "invalid_key" }),
        search({ query: "two", state: "running" }),
      ]),
    ).toEqual({ text: 'Searching the web for "two"…', keySettings: true, failed: false });
  });

  it("says the searches failed when none of them finished", () => {
    expect(
      describeSearches([
        search({ query: "one", state: "error", errorReason: "quota_exhausted" }),
        search({ query: "two", state: "cancelled" }),
      ]),
    ).toEqual({ text: "Search cancelled", keySettings: false, failed: true });
    expect(
      describeSearches([
        search({ query: "one", state: "cancelled" }),
        search({ query: "two", state: "error", errorReason: "quota_exhausted" }),
      ]).text,
    ).toBe("Search failed: Tavily's monthly quota is used up.");
    expect(describeSearches([search({ state: "error" })]).failed).toBe(true);
    expect(describeSearches([search({}), search({ state: "error" })]).failed).toBe(false);
  });
});

describe("domainOf", () => {
  it("is the hostname without www, or the text itself when it isn't a URL", () => {
    expect(domainOf("https://www.example.com/a?b=c")).toBe("example.com");
    expect(domainOf("not a url")).toBe("not a url");
  });
});
