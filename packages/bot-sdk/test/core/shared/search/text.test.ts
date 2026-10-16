import { describe, expect, it } from "vitest";

import { escapeLike, snippetAround } from "../../../../core/shared/search/text";

describe("escapeLike", () => {
  it("escapes the LIKE wildcards and the escape character", () => {
    expect(escapeLike(String.raw`50% off_now \o/`)).toBe(String.raw`50\% off\_now \\o/`);
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLike("plain words")).toBe("plain words");
  });
});

/** The snippet with the match wrapped in [brackets], to read the offsets at a glance. */
function marked(text: string, q: string, length?: number) {
  const { text: snippet, match } = snippetAround(text, q, length);
  return `${snippet.slice(0, match.start)}[${snippet.slice(match.start, match.end)}]${snippet.slice(match.end)}`;
}

describe("snippetAround", () => {
  it("returns short text whole, with the first match's offsets, case-insensitively", () => {
    expect(snippetAround("Tell me about Postgres and postgres", "POSTGRES")).toEqual({
      text: "Tell me about Postgres and postgres",
      match: { start: 14, end: 22 },
    });
  });

  it("centres a window on the match in long text, with ellipses where it was cut", () => {
    const text = `${"a".repeat(100)} needle ${"b".repeat(100)}`;

    expect(marked(text, "needle", 30)).toBe(`…${"a".repeat(11)} [needle] ${"b".repeat(11)}…`);
  });

  it("doesn't cut before the start when the match is near it", () => {
    expect(marked(`needle ${"b".repeat(100)}`, "needle", 20)).toBe(`[needle] ${"b".repeat(13)}…`);
  });

  it("doesn't cut after the end when the match is near it", () => {
    expect(marked(`${"a".repeat(100)} needle`, "needle", 20)).toBe(`…${"a".repeat(13)} [needle]`);
  });

  it("collapses whitespace, so line breaks don't show in one line", () => {
    expect(marked("first line\n\n  second   line", "second line")).toBe("first line [second line]");
  });

  it("keeps offsets right when lower-casing would change the length", () => {
    expect(marked("İstanbul is lovely", "lovely")).toBe("İstanbul is [lovely]");
  });

  it("treats regex characters in the query literally", () => {
    expect(marked("costs $5 (a.k.a. cheap)", "(a.k.a.")).toBe("costs $5 [(a.k.a.] cheap)");
  });

  it("starts the snippet at the beginning, with an empty match, when the query isn't found", () => {
    expect(snippetAround(`${"x".repeat(200)}`, "zz", 10)).toEqual({
      text: `${"x".repeat(10)}…`,
      match: { start: 0, end: 0 },
    });
  });
});
