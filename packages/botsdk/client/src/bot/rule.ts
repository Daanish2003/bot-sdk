import { z } from "zod";

/**
 * A Custom Rule's modes (ADR 0031), loosest first: a matching call passes `without_asking`, passes
 * when `pre_approved` only if the user asked for it, always waits for an Approval with `ask`, and is
 * handed to the user with `hand_off`. The strictest matching rule wins.
 */
export const customRuleModes = ["without_asking", "pre_approved", "ask", "hand_off"] as const;

export type CustomRuleMode = (typeof customRuleModes)[number];

/** How a Custom Rule stands: `proposed` by a Bot until the user's Approval, then `active`. */
export type CustomRuleState = "active" | "proposed";

/** The longest a Custom Rule's text may be, in characters (ADR 0031). */
export const maxCustomRuleLength = 500;

/** The most active Custom Rules a user may have (ADR 0031). */
export const maxActiveCustomRules = 50;

/** A Custom Rule's text: the user's sentence, trimmed, of 1 to 500 characters. */
export const customRuleTextSchema = z.string().trim().min(1).max(maxCustomRuleLength);

/**
 * A Custom Rule as the client sees it: the user's standing instruction for one kind of action, in
 * their own words, for all their Bots. `proposedByBotId` is the Bot that proposed it, null when the
 * user wrote it.
 */
export type CustomRule = {
  id: string;
  text: string;
  mode: CustomRuleMode;
  state: CustomRuleState;
  proposedByBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A rule a Bot proposed, in the thread (spec #989), the Rich control of kind `rule_approval`: it
 * holds only the rule's id, and its state is read from the rule's row.
 */
export const ruleApprovalSchema = z.object({
  kind: z.literal("rule_approval"),
  ruleId: z.string(),
});

export type RuleApproval = z.infer<typeof ruleApprovalSchema>;
