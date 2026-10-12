import { describe, expect, it } from "vitest";

import {
  focusStep,
  localDayRange,
  recentConversations,
  splitSnippet,
} from "../../../core/client/search";

describe("splitSnippet", () => {
  it("splits a snippet around its match", () => {
    expect(splitSnippet({ text: "…try Lisbon's Alfama", match: { start: 5, end: 11 } })).toEqual({
      before: "…try ",
      match: "Lisbon",
      after: "'s Alfama",
    });
  });

  it("puts everything before an empty match", () => {
    expect(splitSnippet({ text: "no match here", match: { start: 0, end: 0 } })).toEqual({
      before: "",
      match: "",
      after: "no match here",
    });
  });
});

describe("recentConversations", () => {
  const conversations = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    title: i === 3 ? null : `Topic ${i}`,
  }));

  it("shows the newest 6 without a query", () => {
    expect(recentConversations(conversations, "").map((c) => c.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("filters titles case-insensitively, up to 20", () => {
    expect(recentConversations(conversations, "TOPIC 1").map((c) => c.id)).toEqual([
      "1",
      ...Array.from({ length: 10 }, (_, i) => String(10 + i)),
    ]);
    expect(recentConversations(conversations, "topic")).toHaveLength(20);
  });

  it("matches an untitled Conversation as Untitled", () => {
    expect(recentConversations(conversations, "untitled").map((c) => c.id)).toEqual(["3"]);
  });
});

describe("localDayRange", () => {
  it("is empty when no day is picked", () => {
    expect(localDayRange(undefined, undefined)).toEqual({});
  });

  it("starts at local midnight of the first day and ends at local midnight after the last", () => {
    expect(localDayRange("2026-10-01", "2026-10-03")).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 4).toISOString(),
    });
  });

  it("covers a single day when both ends are the same day", () => {
    expect(localDayRange("2026-10-01", "2026-10-01")).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 2).toISOString(),
    });
  });

  it("leaves a missing end open", () => {
    expect(localDayRange("2026-10-01", undefined)).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
    });
    expect(localDayRange(undefined, "2026-10-01")).toEqual({
      to: new Date(2026, 9, 2).toISOString(),
    });
  });
});

describe("focusStep", () => {
  it("highlights a Message that's on screen", () => {
    expect(focusStep("b", ["a", "b"], ["a", "b"])).toBe("highlight");
  });

  it("waits while the Active Branch has it but the screen doesn't yet", () => {
    expect(focusStep("b", ["a"], ["a", "b"])).toBe("wait");
  });

  it("switches Branch when the Active Branch doesn't have it", () => {
    expect(focusStep("x", ["a", "b"], ["a", "b"])).toBe("switch");
  });
});
