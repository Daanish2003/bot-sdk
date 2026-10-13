import { describe, expect, it } from "vitest";

import { lastDays, spendByDay, spendRange } from "./spend";

describe("lastDays", () => {
  it("lists the UTC days ending on today, oldest first", () => {
    expect(lastDays(new Date("2026-10-13T23:30:00Z"), 3)).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
  });
});

describe("spendRange", () => {
  it("covers today and the 29 days before it, in UTC", () => {
    expect(spendRange(new Date("2026-10-13T12:00:00Z"))).toEqual({
      since: new Date("2026-09-14T00:00:00Z"),
      until: new Date("2026-10-14T00:00:00Z"),
    });
  });
});

describe("spendByDay", () => {
  it("fills each day with its Models' spend, and zero for a quiet day", () => {
    const rows = [
      { day: "2026-10-12", model: "a", costMicros: 300 },
      { day: "2026-10-12", model: "b", costMicros: 200 },
      { day: "2026-10-10", model: "a", costMicros: 999 },
    ];

    expect(spendByDay(rows, ["2026-10-11", "2026-10-12"])).toEqual([
      { day: "2026-10-11", totalMicros: 0, byModel: {} },
      { day: "2026-10-12", totalMicros: 500, byModel: { a: 300, b: 200 } },
    ]);
  });
});
