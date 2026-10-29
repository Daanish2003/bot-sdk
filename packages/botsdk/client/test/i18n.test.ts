import { describe, expect, it } from "vitest";

import { createI18n } from "../src/i18n";

describe("createI18n", () => {
  it("answers from the English dictionary when the Host passes none", () => {
    expect(createI18n().t("bots.newBot")).toBe("New Bot");
    expect(createI18n().locale).toBe("en");
  });

  it("falls back to English for a key the Host leaves out or sets to undefined", () => {
    const i18n = createI18n({ "bots.newBot": "Neuer Bot", "bots.app": undefined });

    expect(i18n.t("bots.newBot")).toBe("Neuer Bot");
    expect(i18n.t("bots.app")).toBe("Bots");
  });

  it("passes params to a function value", () => {
    const i18n = createI18n({ "bots.tasksCount": ({ count }) => `Aufgaben ${count}` });

    expect(i18n.t("bots.tasksCount", { count: 5 })).toBe("Aufgaben 5");
    // @ts-expect-error a function key needs its params (and throws without them at runtime)
    expect(() => i18n.t("bots.tasksCount")).toThrow(TypeError);
  });

  it("picks the plural form inside a function with Intl.PluralRules", () => {
    const de = new Intl.PluralRules("de");
    const i18n = createI18n({
      "bots.skillsCount": ({ count }) =>
        de.select(count) === "one" ? "1 Skill" : `${count} Skills`,
    });

    expect(i18n.t("bots.skillsCount", { count: 1 })).toBe("1 Skill");
    expect(i18n.t("bots.skillsCount", { count: 3 })).toBe("3 Skills");
  });
});
