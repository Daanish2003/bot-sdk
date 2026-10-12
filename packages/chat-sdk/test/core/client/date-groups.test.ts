import { describe, expect, it } from "vitest";

import { dateGroupLabel, groupByDate } from "../../../core/client/date-groups";

// Local calendar dates, so the boundaries hold in any time zone.
const now = new Date(2026, 9, 10, 15, 30);
const day = (year: number, month: number, date: number, hour = 12) =>
  new Date(year, month, date, hour);

describe("dateGroupLabel", () => {
  it.each([
    [day(2026, 9, 10, 0), "Today"],
    [day(2026, 9, 10, 23), "Today"],
    [day(2026, 9, 9, 0), "Yesterday"],
    [day(2026, 9, 9, 23), "Yesterday"],
    [day(2026, 9, 8), "Previous 7 days"],
    [day(2026, 9, 3), "Previous 7 days"],
    [day(2026, 9, 2), "Previous 30 days"],
    [day(2026, 8, 10), "Previous 30 days"],
    [day(2026, 8, 9), "September 2026"],
    [day(2026, 2, 1), "March 2026"],
    [day(2025, 11, 31), "December 2025"],
  ])("puts %s in %s", (at, label) => {
    expect(dateGroupLabel(at, now)).toBe(label);
  });

  it("puts a time later today, after `now`, in Today", () => {
    expect(dateGroupLabel(day(2026, 9, 10, 23), now)).toBe("Today");
  });
});

describe("groupByDate", () => {
  it("keeps the rows' order and starts a new group at each label change", () => {
    const rows = [
      { id: "a", at: day(2026, 9, 10, 9) },
      { id: "b", at: day(2026, 9, 10, 1) },
      { id: "c", at: day(2026, 9, 9, 20) },
      { id: "d", at: day(2026, 8, 9) },
    ];

    expect(groupByDate(rows, (row) => row.at, now)).toEqual([
      { label: "Today", rows: [rows[0], rows[1]] },
      { label: "Yesterday", rows: [rows[2]] },
      { label: "September 2026", rows: [rows[3]] },
    ]);
  });
});
