import { describe, expect, it } from "vitest";

import {
  maskedFormsOf,
  maskResult,
  maskSecrets,
  secretMasker,
} from "../../../../plugins/bot/server/safety";

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
});
