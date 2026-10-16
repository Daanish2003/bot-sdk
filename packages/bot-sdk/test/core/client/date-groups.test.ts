import { describe, expect, it } from "vitest";

import { dateGroupLabel, groupByDate } from "../../../core/client/date-groups";
import { createI18n } from "../../../core/shared/i18n";
import { germanMessages } from "../../support/i18n";

// Local calendar dates, so the boundaries hold in any time zone.
const now = new Date(2026, 9, 10, 15, 30);
const day = (year: number, month: number, date: number, hour = 12) =>
  new Date(year, month, date, hour);
const en = createI18n();

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
    expect(dateGroupLabel(en, at, now)).toBe(label);
  });

  it("puts a time later today, after `now`, in Today", () => {
    expect(dateGroupLabel(en, day(2026, 9, 10, 23), now)).toBe("Today");
  });

  it("shows the group words and the month in the Host's dictionary and locale", () => {
    const de = createI18n(germanMessages, "de");

    expect(dateGroupLabel(de, day(2026, 9, 10, 9), now)).toBe("Heute");
    expect(dateGroupLabel(de, day(2026, 9, 9), now)).toBe("Gestern");
    expect(dateGroupLabel(de, day(2026, 9, 3), now)).toBe("Letzte 7 Tage");
    expect(dateGroupLabel(de, day(2026, 9, 2), now)).toBe("Letzte 30 Tage");
    expect(dateGroupLabel(de, day(2026, 1, 3), now)).toBe("Februar 2026");
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

    expect(groupByDate(rows, (row) => row.at, en, now)).toEqual([
      { label: "Today", rows: [rows[0], rows[1]] },
      { label: "Yesterday", rows: [rows[2]] },
      { label: "September 2026", rows: [rows[3]] },
    ]);
  });
});
