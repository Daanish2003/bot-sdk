import { describe, expect, it } from "vitest";

import {
  createName,
  firstLine,
  lastRowLabel,
  rankSavedPrompts,
  savedPromptDraftError,
  slashQuery,
} from "../../../core/client/saved-prompts-menu";

describe("slashQuery", () => {
  it("is the name typed after a leading slash, while the whole value is that", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/review-pr")).toBe("review-pr");
  });

  it("is closed once the value has a space, a newline or no leading slash", () => {
    expect(slashQuery("/rev ")).toBeUndefined();
    expect(slashQuery("/rev\nmore")).toBeUndefined();
    expect(slashQuery("review /rev")).toBeUndefined();
    expect(slashQuery("a/b")).toBeUndefined();
    expect(slashQuery("")).toBeUndefined();
  });
});

describe("rankSavedPrompts", () => {
  const prompts = [
    { name: "standup", text: "Turn notes into a review" },
    { name: "review-pr", text: "Summarise a diff" },
    { name: "code-review", text: "Review this code" },
    { name: "eli5", text: "Explain it simply" },
  ];

  it("lists names starting with the query first, then names containing it, then text", () => {
    expect(rankSavedPrompts(prompts, "rev").map((prompt) => prompt.name)).toEqual([
      "review-pr",
      "code-review",
      "standup",
    ]);
  });

  it("keeps every prompt in order for an empty query", () => {
    expect(rankSavedPrompts(prompts, "")).toEqual(prompts);
  });

  it("matches case-insensitively and drops prompts that match nowhere", () => {
    expect(rankSavedPrompts(prompts, "EXPLAIN").map((prompt) => prompt.name)).toEqual(["eli5"]);
    expect(rankSavedPrompts(prompts, "zzz")).toEqual([]);
  });
});

describe("firstLine", () => {
  it("is the first line that has text, trimmed", () => {
    expect(firstLine("\n  Review this code.  \n\nMore")).toBe("Review this code.");
    expect(firstLine("")).toBe("");
  });
});

describe("createName", () => {
  it("is the query when it is a valid name, otherwise nothing", () => {
    expect(createName("xyz")).toBe("xyz");
    expect(createName("")).toBeUndefined();
    expect(createName("Bad_Name")).toBeUndefined();
  });
});

describe("lastRowLabel", () => {
  it("creates the query as a name when nothing matches and it is a valid name", () => {
    expect(lastRowLabel("xyz", 0)).toBe("Create /xyz…");
  });

  it("is New Saved prompt… when something matches, even for a valid query", () => {
    expect(lastRowLabel("rev", 2)).toBe("New Saved prompt…");
  });

  it("is New Saved prompt… when the query is empty or not a valid name", () => {
    expect(lastRowLabel("", 0)).toBe("New Saved prompt…");
    expect(lastRowLabel("Bad Name", 0)).toBe("New Saved prompt…");
  });
});

describe("savedPromptDraftError", () => {
  const prompts = [{ name: "review", text: "Review" }];

  it("is undefined for a valid new name and text", () => {
    expect(savedPromptDraftError(prompts, { name: "eli5", text: "Explain" })).toBeUndefined();
  });

  it("names the rule a draft breaks", () => {
    expect(savedPromptDraftError(prompts, { name: "Bad Name", text: "x" })).toMatch(/lowercase/);
    expect(savedPromptDraftError(prompts, { name: "review", text: "x" })).toBe(
      'You already have a Saved prompt named "review"',
    );
    expect(savedPromptDraftError(prompts, { name: "eli5", text: "   " })).toBe(
      "Text can't be blank",
    );
    expect(savedPromptDraftError(prompts, { name: "eli5", text: "x".repeat(10_001) })).toBe(
      "Text is limited to 10,000 characters",
    );
  });

  it("refuses a new prompt once the user has 100", () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ name: `p${index}`, text: "x" }));
    expect(savedPromptDraftError(full, { name: "new", text: "x" })).toBe(
      "You have 100 Saved prompts. Delete one first.",
    );
  });
});
