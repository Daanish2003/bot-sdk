import { describe, expect, it } from "vitest";

import { banEndsAt, isBanActive, isCalendarDate } from "./ban";

const now = new Date("2026-10-13T12:00:00Z");

describe("isBanActive", () => {
  it("is not a Ban for a user who isn't banned", () => {
    expect(isBanActive({ banned: false, banExpires: null }, now)).toBe(false);
  });

  it("holds for a Ban with no end date", () => {
    expect(isBanActive({ banned: true, banExpires: null }, now)).toBe(true);
  });

  it("holds until its end date, and lifts from that moment", () => {
    const ends = new Date("2026-10-14T00:00:00Z");

    expect(isBanActive({ banned: true, banExpires: ends }, new Date("2026-10-13T23:59:59Z"))).toBe(
      true,
    );
    expect(isBanActive({ banned: true, banExpires: ends }, ends)).toBe(false);
  });
});

describe("banEndsAt", () => {
  it("is no end for a Ban without a date", () => {
    expect(banEndsAt(null)).toBeNull();
  });

  it("is the end of the chosen UTC day, so the Ban covers that whole day", () => {
    expect(banEndsAt("2026-10-20")).toEqual(new Date("2026-10-21T00:00:00Z"));
  });
});

describe("isCalendarDate", () => {
  it("accepts a real YYYY-MM-DD date, including a leap day", () => {
    expect(isCalendarDate("2026-10-20")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
  });

  it("refuses dates that the calendar doesn't have", () => {
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-02-29")).toBe(false);
  });
});
