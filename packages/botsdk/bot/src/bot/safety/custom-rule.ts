import {
  type CustomRule,
  type CustomRuleMode,
  maxActiveCustomRules,
} from "@botsdk/client/bot/rule";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { bot, customRule } from "../../storage";
import type { Database } from "../../storage";
import { hintChanged, recordBotChange } from "../conversation";
import { lockConversation } from "../triggers";

/*
 * Custom Rules (ADR 0031): the user's standing instructions, in their own words, for all their Bots.
 * Auto-review reads the active ones with the user's Messages, and each Bot's Prompt start lists
 * them. A proposed rule, which a Bot suggested, applies to nothing until the user approves it.
 */

/** How each mode reads in a prompt: the reviewer's and the Bot's. */
const modeLabels: Record<CustomRuleMode, string> = {
  without_asking: "without asking",
  pre_approved: "if pre-approved",
  ask: "ask before",
  hand_off: "hand off to the user",
};

const ruleFields = {
  id: customRule.id,
  text: customRule.text,
  mode: customRule.mode,
  state: customRule.state,
  proposedByBotId: customRule.proposedByBotId,
  createdAt: customRule.createdAt,
  updatedAt: customRule.updatedAt,
};

const oldestFirst = [asc(customRule.createdAt), asc(customRule.id)] as const;

/** The user's Custom Rules, active and proposed, the oldest first. */
export async function listRules(db: Database, userId: string): Promise<CustomRule[]> {
  return db
    .select(ruleFields)
    .from(customRule)
    .where(eq(customRule.userId, userId))
    .orderBy(...oldestFirst);
}

/** The user's active Custom Rules, the oldest first, as a prompt lists them: one line each. */
async function activeRuleLines(db: Database | Transaction, userId: string): Promise<string[]> {
  const rows = await db
    .select({ text: customRule.text, mode: customRule.mode })
    .from(customRule)
    .where(and(eq(customRule.userId, userId), eq(customRule.state, "active")))
    .orderBy(...oldestFirst);
  // A rule is one line, so a Change note or a reviewer's list never breaks across lines.
  return rows.map((row) => `[${modeLabels[row.mode]}] ${row.text.replace(/\s+/g, " ")}`);
}

/** The reviewer's list of the user's active Custom Rules; a proposed one is never in it. */
export async function reviewedRules(db: Database, userId: string): Promise<string> {
  const lines = await activeRuleLines(db, userId);
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "(none)";
}

/** The header of the Custom Rules block in a Bot's Prompt start. */
export const customRulesHeader = "Your user's Custom Rules:";

/**
 * The Custom Rules block of a Bot's Prompt start: the user's active rules, one line each, with the
 * mode in brackets. `undefined` when the user has none.
 */
export async function customRulesPrompt(
  db: Database | Transaction,
  userId: string,
): Promise<string | undefined> {
  const lines = await activeRuleLines(db, userId);
  return lines.length > 0 ? [customRulesHeader, ...lines].join("\n") : undefined;
}

/**
 * Runs `write` in a transaction that holds the row lock of each of the user's Bots' Conversations,
 * in one order as every write that changes a thread does, then records a `rule` change for the rule
 * `write` names in each and hints them. `write` returns the rule's id and the method's result.
 */
async function changeRules<T>(
  sdk: BotSdkContext,
  userId: string,
  write: (tx: Transaction, now: Date) => Promise<{ ruleId: string; result: T }>,
): Promise<T> {
  const now = sdk.clock();
  const { owned, result } = await sdk.db.transaction(async (tx) => {
    // One writer per user at a time, even for a user with no Bot to lock: the limit counts rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"custom_rule:" + userId}))`);
    const owned = await tx
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.userId, userId))
      .orderBy(asc(bot.conversationId));
    for (const { conversationId } of owned) await lockConversation(tx, conversationId);
    const written = await write(tx, now);
    for (const owner of owned) await recordBotChange(tx, owner, "rule", written.ruleId, now);
    return { owned, result: written.result };
  });
  for (const { conversationId } of owned) await hintChanged(sdk, conversationId);
  return result;
}

const notFound = () => rpcError("NOT_FOUND", "error.customRuleNotFound", "Rule not found");

/** Refuses a write that would leave the user more than `maxActiveCustomRules` active rules. */
async function requireRoom(tx: Transaction, userId: string) {
  const [active] = await tx
    .select({ n: count() })
    .from(customRule)
    .where(and(eq(customRule.userId, userId), eq(customRule.state, "active")));
  if ((active?.n ?? 0) >= maxActiveCustomRules) {
    throw rpcError("BAD_REQUEST", "error.customRuleLimit", "Too many active rules", {
      max: maxActiveCustomRules,
    });
  }
}

/** Writes an active Custom Rule for the user. Refused past the 50 active rules. */
export async function createRule(
  sdk: BotSdkContext,
  userId: string,
  { text, mode }: { text: string; mode: CustomRuleMode },
): Promise<CustomRule> {
  return changeRules(sdk, userId, async (tx, now) => {
    await requireRoom(tx, userId);
    const [created] = await tx
      .insert(customRule)
      .values({
        id: uuidv7(),
        userId,
        text,
        mode,
        state: "active",
        proposedByBotId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning(ruleFields);
    return { ruleId: created!.id, result: created! };
  });
}

/** Edits the text or the mode of the user's rule `ruleId`. Another user's is not found. */
export async function updateRule(
  sdk: BotSdkContext,
  userId: string,
  { ruleId, text, mode }: { ruleId: string; text?: string; mode?: CustomRuleMode },
): Promise<CustomRule> {
  return changeRules(sdk, userId, async (tx, now) => {
    const [updated] = await tx
      .update(customRule)
      .set({
        ...(text !== undefined && { text }),
        ...(mode !== undefined && { mode }),
        updatedAt: now,
      })
      .where(and(eq(customRule.id, ruleId), eq(customRule.userId, userId)))
      .returning(ruleFields);
    if (!updated) throw notFound();
    return { ruleId, result: updated };
  });
}

/** Deletes the user's rule `ruleId`, in any state. Another user's is not found. */
export async function deleteRule(
  sdk: BotSdkContext,
  userId: string,
  ruleId: string,
): Promise<void> {
  await changeRules(sdk, userId, async (tx) => {
    const deleted = await tx
      .delete(customRule)
      .where(and(eq(customRule.id, ruleId), eq(customRule.userId, userId)))
      .returning({ id: customRule.id });
    if (deleted.length === 0) throw notFound();
    return { ruleId, result: undefined };
  });
}
