import { describe, expect, it } from "vitest";

import { createI18n } from "../../../core/shared/i18n";

describe("createI18n", () => {
  it("answers from the English dictionary when the Host passes none", () => {
    expect(createI18n().t("time.today")).toBe("Today");
    expect(createI18n().locale).toBe("en");
  });

  it("falls back to English for a key the Host leaves out or sets to undefined", () => {
    const i18n = createI18n({ "time.today": "Heute", "time.yesterday": undefined });

    expect(i18n.t("time.today")).toBe("Heute");
    expect(i18n.t("time.yesterday")).toBe("Yesterday");
  });

  it("passes params to a function value", () => {
    const i18n = createI18n({ "time.minutesAgo": ({ count }) => `vor ${count} Min.` });

    expect(i18n.t("time.minutesAgo", { count: 5 })).toBe("vor 5 Min.");
  });

  it("picks the plural form inside a function with Intl.PluralRules", () => {
    const de = new Intl.PluralRules("de");
    const i18n = createI18n({
      "time.hoursAgo": ({ count }) =>
        de.select(count) === "one" ? "vor 1 Std." : `vor ${count} Std.`,
    });

    expect(i18n.t("time.hoursAgo", { count: 1 })).toBe("vor 1 Std.");
    expect(i18n.t("time.hoursAgo", { count: 3 })).toBe("vor 3 Std.");
  });
});
