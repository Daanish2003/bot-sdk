import { describe, expect, it } from "vitest";

import { relativeTime } from "../../../core/client/relative-time";
import { createI18n } from "../../../core/shared/i18n";
import { germanMessages } from "../../support/i18n";

const now = new Date("2026-10-06T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const en = createI18n();

describe("relativeTime", () => {
  it.each([
    [ago(30), "just now"],
    [ago(5 * 60), "5m ago"],
    [ago(3 * 3600), "3h ago"],
    [ago(2 * 86400), "2d ago"],
  ])("shows %s as %s", (at, expected) => {
    expect(relativeTime(en, at, now)).toBe(expected);
  });

  it("shows a date from more than a week ago as month and day", () => {
    expect(relativeTime(en, new Date("2026-09-20T12:00:00Z"), now)).toBe("Sep 20");
  });

  it("shows the words and the date in the Host's dictionary and locale", () => {
    const de = createI18n(germanMessages, "de");
    const sepTwenty = new Date("2026-09-20T12:00:00Z");

    expect(relativeTime(de, ago(30), now)).toBe("gerade eben");
    expect(relativeTime(de, ago(5 * 60), now)).toBe("vor 5 Min.");
    expect(relativeTime(de, sepTwenty, now)).toBe(
      new Intl.DateTimeFormat("de", { month: "short", day: "numeric" }).format(sepTwenty),
    );
    expect(relativeTime(de, sepTwenty, now)).not.toBe("Sep 20");
  });
});
