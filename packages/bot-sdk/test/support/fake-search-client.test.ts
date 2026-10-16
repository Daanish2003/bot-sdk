import { describe, expect, it } from "vitest";

import { SearchError } from "../../core/server/deps";
import { createFakeSearchClient } from "./fake-search-client";

const result = {
  title: "TanStack AI",
  url: "https://tanstack.com/ai",
  snippet: "Type-safe AI SDK",
};

describe("createFakeSearchClient", () => {
  it("returns the scripted results and records each query", async () => {
    const fake = createFakeSearchClient({ results: [result] });

    await expect(fake.search("tanstack ai", { apiKey: "tvly-test" })).resolves.toEqual([result]);
    expect(fake.calls).toEqual([{ query: "tanstack ai", credentials: { apiKey: "tvly-test" } }]);
  });

  it("returns no results by default", async () => {
    await expect(createFakeSearchClient().search("anything", {})).resolves.toEqual([]);
  });

  it.each(["invalid_key", "quota_exhausted", "failed"] as const)(
    "throws a SearchError with reason %s",
    async (reason) => {
      const fake = createFakeSearchClient({ error: reason });

      const error = await fake.search("q", {}).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SearchError);
      expect(error).toMatchObject({ reason });
    },
  );
});
