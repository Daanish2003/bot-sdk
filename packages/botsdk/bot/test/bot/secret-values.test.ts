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

  it("masks a value a NUL splits or stands next to, as a Checkpoint would drop the NUL and join it", () => {
    const value = "ghp_abcdef123456";
    const split = `${value.slice(0, 6)}\0${value.slice(6)}`;

    expect(maskSecrets(`a ${split} b`, [value])).toBe("a *** b");
    expect(maskSecrets(`a \0${value}\0 b`, [value])).toBe("a *** b");
    expect(maskSecrets(`\0a\0`, [value])).toBe("a");
  });

  it("masks a value that holds a NUL, as written and without it, and its encoded forms", () => {
    const value = "ghp_abc\0def123456";

    expect(maskSecrets(`a ${value} b`, [value])).toBe("a *** b");
    expect(maskSecrets("a ghp_abcdef123456 b", [value])).toBe("a *** b");
    expect(maskSecrets(`a ${base64(value)} b`, [value])).toBe("a *** b");
    expect(maskSecrets(`a ${encodeURIComponent(value)} b`, [value])).toBe("a *** b");
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
});
