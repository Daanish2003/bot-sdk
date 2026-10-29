import { createRuleInput, ruleInput, updateRuleInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { neverAllowedList, createRule, deleteRule, listRules, updateRule } from "./safety";

/*
 * The `rules` namespace's domain methods (spec #989): the user's Custom Rules (ADR 0031), shared by
 * all their Bots. Each takes one object with `userId`; the procedures are one-line wrappers.
 */

/** The `rules` namespace over the core context. */
export function rulesApi(sdk: BotSdkContext) {
  return {
    /** The user's Custom Rules, active and proposed, the oldest first. */
    list: async ({ userId }: { userId: string }) => listRules(sdk.db, userId),

    /** The Never-allowed classes (ADR 0032): the SDK's, then the Host's extra ones. */
    neverAllowed: async () => neverAllowedList(sdk.bots.neverAllowed),

    /** Writes an active rule. Refused past 50 active rules. */
    create: async ({ userId, ...rest }: WithUser<typeof createRuleInput>) =>
      createRule(sdk, userId, parseInput(createRuleInput, rest)),

    /** Edits a rule's text or mode. Another user's rule is not found. */
    update: async ({ userId, ...rest }: WithUser<typeof updateRuleInput>) =>
      updateRule(sdk, userId, parseInput(updateRuleInput, rest)),

    /** Deletes a rule in any state. Another user's rule is not found. */
    delete: async ({ userId, ...rest }: WithUser<typeof ruleInput>) =>
      deleteRule(sdk, userId, parseInput(ruleInput, rest).ruleId),
  };
}

/** The `rules` namespace's domain methods. */
export type RulesApi = ReturnType<typeof rulesApi>;
