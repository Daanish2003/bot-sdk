import { describe, expect, it } from "vitest";

import { createRuleInput, ruleInput, updateRuleInput } from "@botsdk/client/bot/contract";
import { customRuleModes, maxCustomRuleLength } from "@botsdk/client/bot/rule";

const ruleId = "0199a8f0-0000-7000-8000-000000000001";

describe("a Custom Rule's input", () => {
  it("takes the user's sentence of 1 to 500 characters, trimmed, with one of the four modes", () => {
    expect(customRuleModes).toEqual(["without_asking", "pre_approved", "ask", "hand_off"]);
    expect(maxCustomRuleLength).toBe(500);

    expect(
      createRuleInput.parse({ text: "  Reply to emails from anyone @acme.com ", mode: "ask" }),
    ).toEqual({ text: "Reply to emails from anyone @acme.com", mode: "ask" });
    expect(createRuleInput.safeParse({ text: "x".repeat(500), mode: "hand_off" }).success).toBe(
      true,
    );
    expect(createRuleInput.safeParse({ text: "x".repeat(501), mode: "hand_off" }).success).toBe(
      false,
    );
    expect(createRuleInput.safeParse({ text: "   ", mode: "ask" }).success).toBe(false);
    expect(createRuleInput.safeParse({ text: "Book flights", mode: "always" }).success).toBe(false);
  });

  it("edits a rule's text, its mode or both, by its id", () => {
    expect(updateRuleInput.parse({ ruleId, mode: "without_asking" })).toEqual({
      ruleId,
      mode: "without_asking",
    });
    expect(updateRuleInput.safeParse({ ruleId, text: "" }).success).toBe(false);
    expect(updateRuleInput.safeParse({ ruleId }).success).toBe(false);
    expect(ruleInput.safeParse({ ruleId: "r1" }).success).toBe(false);
  });
});
