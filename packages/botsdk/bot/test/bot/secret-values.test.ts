import { describe, expect, it } from "vitest";

import { maskedFormsOf, maskResult, maskSecrets, secretMasker } from "../../src/bot/safety";

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** `text` wrapped at `width` columns, as GNU `base64` prints it. */
const wrapped = (text: string, width = 76) =>
  (text.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join("\n");

describe("masking a Secret's value", () => {
  it("masks the base64 of the value followed by a newline, as `echo $KEY | base64` prints it", () => {
    const value = "ghp_abcdef123456";

    expect(maskSecrets(`out: ${base64(`${value}\n`)}\n`, [value])).toBe("out: ***\n");
    expect(maskedFormsOf([value])).toContain(base64(`${value}\n`));
  });

  it("masks a base64 form wrapped across lines at 76 columns", () => {
    const value = "sk-".padEnd(120, "x0Y1z2");
    const printed = wrapped(base64(`${value}\n`));
    expect(printed).toContain("\n");

    expect(maskSecrets(`${printed}\n`, [value])).toBe("***\n");
    expect(maskSecrets(wrapped(base64(value)), [value])).toBe("***");
    // The Computer's streaming redaction takes plain strings: it gets the wrapped form too.
    expect(maskedFormsOf([value])).toContain(printed);
  });

  it("masks every string of a result, and leaves one with no Secret as it is", () => {
    const value = "hunter2-long";
    const result = { lines: [`a ${value}`, encodeURIComponent(`${value}`)], n: 1 };

    expect(maskResult(result, secretMasker([value]))).toEqual({ lines: ["a ***", "***"], n: 1 });
    expect(maskResult(result, secretMasker([]))).toBe(result);
  });

  it("reads a value that isn't plain JSON as JSON does, so a masked result keeps it", () => {
    const value = "hunter2-long";
    const at = new Date("2026-01-02T03:04:05.000Z");
    const result = { at, custom: { toJSON: () => `by ${value}` }, found: value };

    expect(maskResult(result, secretMasker([value]))).toEqual({
      at: at.toISOString(),
      custom: "by ***",
      found: "***",
    });
  });

  it("gives the same result masked twice as masked once", () => {
    const value = "hunter2-long";
    const mask = secretMasker([value]);
    const once = maskResult({ lines: [value, `a ${value} b`], text: value }, mask);

    expect(maskResult(once, mask)).toEqual(once);
  });

  describe("a Secret's value in a key", () => {
    const value = "hunter2-long";
    const other = "other+secret/value";
    const mask = secretMasker([value, other]);

    it("masks a key that is the value, or holds it or one of its other forms as a part", () => {
      const result = {
        [value]: 1,
        [`token_${value}`]: { [`${base64(value)}:nested`]: 2 },
        list: [{ [`?t=${encodeURIComponent(other)}`]: 3 }],
      };

      expect(maskResult(result, mask)).toEqual({
        "***": 1,
        "token_***": { "***:nested": 2 },
        list: [{ "?t=***": 3 }],
      });
    });

    it("keeps every value when keys mask alike, each in the place its key had", () => {
      const masked = maskResult(
        { [value]: "plain", a: 0, [base64(value)]: "encoded", [other]: "other" },
        mask,
      );

      expect(Object.entries(masked)).toEqual([
        ["***", "plain"],
        ["a", 0],
        ["*** 2", "encoded"],
        ["*** 3", "other"],
      ]);
    });

    it("leaves a key with no Secret its name, and numbers the key that held one", () => {
      const masked = maskResult({ [value]: "secret", "***": "kept", "*** 2": "kept too" }, mask);

      expect(Object.entries(masked)).toEqual([
        ["*** 3", "secret"],
        ["***", "kept"],
        ["*** 2", "kept too"],
      ]);
    });

    it("never numbers a key into a Secret's value", () => {
      const numbered = secretMasker([value, other, "*** 2"]);

      const masked = maskResult({ [value]: "one", [other]: "two" }, numbered);

      expect(masked).toEqual({ "***": "one", "*** 3": "two" });
      expect(maskResult(masked, numbered)).toEqual(masked);
    });

    it("masks a key until no value is left, when masking leaves one (a Secret that looks masked)", () => {
      const starry = secretMasker(["****"]);

      expect(maskResult({ "*****": 1 }, starry)).toEqual({ "***": 1 });
    });

    it("gives the same keys masked twice as masked once, in the same order", () => {
      const once = maskResult(
        { [value]: 1, b: { [base64(value)]: 2, [value]: 3 }, [base64(value)]: 4, "***": 5 },
        mask,
      );

      expect(JSON.stringify(maskResult(once, mask))).toBe(JSON.stringify(once));
    });

    it("keeps a result with no Secret in its keys exactly: its shape and its key order", () => {
      const result = { z: 1, a: { y: [1, { x: value }], b: null }, 2: "two", 1: "one", "": true };

      expect(JSON.stringify(maskResult(result, mask))).toBe(
        JSON.stringify(result).replace(value, "***"),
      );
    });

    it("keeps a __proto__ key an ordinary key, so no prototype changes", () => {
      const result = JSON.parse(`{"__proto__":{"${value}":"${value}","polluted":true}}`);

      const masked = maskResult(result, mask);

      expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
      expect(JSON.stringify(masked)).toBe('{"__proto__":{"***":"***","polluted":true}}');
      expect(masked.polluted).toBeUndefined();
    });
  });
});
