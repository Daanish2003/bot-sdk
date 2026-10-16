import { describe, expect, it } from "vitest";

import { citationFor, excerptFor } from "../../../../core/shared/chat/citations";
import type { Source } from "../../../../core/shared/chat/sources";

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

describe("excerptFor", () => {
  const excerpts = [
    { number: 2, label: "excerpt:1", fileName: "brief.md", text: "The budget." },
    { number: 3, label: "excerpt:2", fileName: "spec.pdf" },
  ];

  it("turns a link to an Excerpt's label into that Excerpt", () => {
    expect(excerptFor("excerpt:2", excerpts)?.number).toBe(3);
  });

  it("leaves a link to a label this Message doesn't have, or a web link, plain", () => {
    expect(excerptFor("excerpt:9", excerpts)).toBeNull();
    expect(excerptFor("https://tanstack.com/ai", excerpts)).toBeNull();
    expect(excerptFor(undefined, excerpts)).toBeNull();
  });
});
