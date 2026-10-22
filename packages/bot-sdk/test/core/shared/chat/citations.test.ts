import { describe, expect, it } from "vitest";

import { citationFor } from "../../../../plugins/assistant/shared/chat/citations";
import type { Source } from "../../../../plugins/assistant/shared/chat/sources";

const sources: Source[] = [
  { number: 1, url: "https://tanstack.com/ai/latest", title: "TanStack AI", snippet: "…" },
  { number: 2, url: "https://example.com/post/", title: "A post", snippet: "…" },
];

describe("citationFor", () => {
  it("turns a link to one of this Message's Sources into that Source", () => {
    expect(citationFor("https://tanstack.com/ai/latest", sources)?.number).toBe(1);
  });

  it("matches despite a fragment or a trailing slash", () => {
    expect(citationFor("https://tanstack.com/ai/latest/#tools", sources)?.number).toBe(1);
    expect(citationFor("https://example.com/post", sources)?.number).toBe(2);
  });

  it("leaves any other link plain", () => {
    expect(citationFor("https://tanstack.com/ai", sources)).toBeNull();
    expect(citationFor("https://other.dev/", sources)).toBeNull();
    expect(citationFor(undefined, sources)).toBeNull();
    expect(citationFor("https://tanstack.com/ai/latest", [])).toBeNull();
  });
});
