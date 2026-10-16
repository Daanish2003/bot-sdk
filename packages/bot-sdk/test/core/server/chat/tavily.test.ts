import { describe, expect, it } from "vitest";

import { SearchError } from "../../../../core/server/deps";
import { createTavilyClient } from "../../../../core/server/chat/tavily";

/** A trimmed Tavily `/search` response, written by hand from the API reference. */
const tavilyResponse = {
  query: "tanstack ai release",
  answer: null,
  images: [],
  results: [
    {
      title: "TanStack AI 0.64",
      url: "https://tanstack.com/blog/ai-0-64",
      content: "TanStack AI 0.64 adds lazy tools.",
      score: 0.91,
      raw_content: null,
      published_date: "2026-10-01",
    },
    {
      title: "TanStack AI docs",
      url: "https://tanstack.com/ai/latest",
      content: "Type-safe AI SDK for TypeScript.",
      score: 0.8,
      raw_content: null,
    },
  ],
  response_time: 1.23,
};

function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof response === "function" ? response() : response;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Tavily search client", () => {
  it("asks Tavily for about 5 basic-depth results with the user's key", async () => {
    const { fetch, calls } = stubFetch(Response.json(tavilyResponse));

    await createTavilyClient(fetch).search("tanstack ai release", { apiKey: "tvly-test" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tvly-test");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      query: "tanstack ai release",
      search_depth: "basic",
      max_results: 5,
    });
  });

  it("maps each result to title, url, snippet and the published date when there is one", async () => {
    const { fetch } = stubFetch(Response.json(tavilyResponse));

    const results = await createTavilyClient(fetch).search("q", { apiKey: "tvly-test" });

    expect(results).toEqual([
      {
        title: "TanStack AI 0.64",
        url: "https://tanstack.com/blog/ai-0-64",
        snippet: "TanStack AI 0.64 adds lazy tools.",
        publishedDate: "2026-10-01",
      },
      {
        title: "TanStack AI docs",
        url: "https://tanstack.com/ai/latest",
        snippet: "Type-safe AI SDK for TypeScript.",
      },
    ]);
  });

  it("keeps at most 5 results", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: "…",
      score: 0.5,
    }));
    const { fetch } = stubFetch(Response.json({ ...tavilyResponse, results: many }));

    const results = await createTavilyClient(fetch).search("q", { apiKey: "tvly-test" });

    expect(results.map((result) => result.title)).toEqual([
      "Result 0",
      "Result 1",
      "Result 2",
      "Result 3",
      "Result 4",
    ]);
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [432, "quota_exhausted"],
    [433, "quota_exhausted"],
    [429, "failed"],
    [400, "failed"],
    [500, "failed"],
  ] as const)("turns HTTP %i into a SearchError with reason %s", async (status, reason) => {
    const { fetch } = stubFetch(Response.json({ detail: { error: "nope" } }, { status }));

    const error = await createTavilyClient(fetch)
      .search("q", { apiKey: "tvly-test" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SearchError);
    expect(error).toMatchObject({ reason });
  });

  it("turns a network failure or a malformed body into reason failed", async () => {
    const offline = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const garbled = stubFetch(Response.json({ results: "not a list" }));

    for (const { fetch } of [offline, garbled]) {
      const error = await createTavilyClient(fetch)
        .search("q", { apiKey: "tvly-test" })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "SearchError", reason: "failed" });
    }
  });

  it("gives up on a search Tavily doesn't answer in time, as reason failed", async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;

    const error = await createTavilyClient(hanging, { timeoutMs: 20 })
      .search("q", { apiKey: "tvly-test" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "SearchError", reason: "failed" });
  });

  it("passes the abort signal on to fetch", async () => {
    const { fetch, calls } = stubFetch(Response.json(tavilyResponse));
    const controller = new AbortController();

    await createTavilyClient(fetch).search(
      "q",
      { apiKey: "tvly-test" },
      { signal: controller.signal },
    );

    controller.abort();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });
});
