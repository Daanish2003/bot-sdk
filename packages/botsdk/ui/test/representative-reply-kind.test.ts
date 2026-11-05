import { describe, expect, it } from "vitest";

import { representativeMessages } from "../../client/src/i18n/en/representative";

const label = representativeMessages["representative.replyKind"];

describe("a reply's kind, as the owner reads it", () => {
  it.each([
    ["answer", "An answer"],
    ["small_talk", "Small talk"],
    ["handoff", "Says it was passed on"],
    ["cant_confirm", "Says it can't confirm"],
    ["code_handoff", "Code's fixed hand-off message"],
    ["limit_note", "Code's fixed note at a limit"],
  ] as const)("shows %s plainly", (kind, plain) => {
    expect(label({ kind })).toBe(plain);
  });
});
