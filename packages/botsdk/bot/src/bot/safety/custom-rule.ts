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
import { appendBotMessage, controlParts, hintChanged, recordBotChange } from "../conversation";
import { lockConversation, receive } from "../triggers";

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
 * Takes, in `tx`, the user's rule lock, then the row lock of each of their Bots' Conversations in
 * one order, as every write that changes a thread does: every rule write takes them so. Returns
 * those Conversations, for the `rule` change each records.
 */
async function lockRules(tx: Transaction, userId: string) {
  // One writer per user at a time, even for a user with no Bot to lock: the limit counts rows.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"custom_rule:" + userId}))`);
  const owned = await tx
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.userId, userId))
    .orderBy(asc(bot.conversationId));
  for (const { conversationId } of owned) await lockConversation(tx, conversationId);
  return owned;
}

/** Hints each of the user's Bots' threads that a rule changed, once its write has committed. */
export async function hintRuleChanged(sdk: BotSdkContext, userId: string): Promise<void> {
  const owned = await sdk.db
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.userId, userId));
  for (const { conversationId } of owned) await hintChanged(sdk, conversationId);
}

/**
 * Runs `write` in a transaction that holds the user's rule locks (`lockRules`), then records a
 * `rule` change for the rule `write` names in each of their Bots' threads and hints them. `write`
 * returns the rule's id and the method's result.
 */
async function changeRules<T>(
  sdk: BotSdkContext,
  userId: string,
  write: (tx: Transaction, now: Date) => Promise<{ ruleId: string; result: T }>,
): Promise<T> {
  const now = sdk.clock();
  const { owned, result } = await sdk.db.transaction(async (tx) => {
    const owned = await lockRules(tx, userId);
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
/** The Bot's tool that proposes a Custom Rule (ADR 0031). */
export const proposeRuleToolName = "propose_rule";

/** What `propose_rule` returns once the rule is saved: it applies once the user approves it. */
export const ruleProposedResult = "Proposed; it applies once the user approves it.";

/** What `propose_rule` returns while the Bot's earlier proposal waits for the user's answer. */
export const openProposalError =
  "You already proposed a Custom Rule the user hasn't answered yet: wait for the user's answer " +
  "to that proposal before you propose another.";

/** The id of rule `ruleId`'s Approval Trigger: one per rule, so a repeat is dropped. */
/** Not under `approval:`, which is a review id's prefix. */
export const ruleApprovalTriggerId = (ruleId: string) => `rule-approval:${ruleId}`;

/** What a rule's Approval Trigger wakes the Bot with: which proposed rule the user answered, and how. */
export function ruleApprovalTriggerText(
  rule: { text: string; mode: CustomRuleMode },
  answer: "approved" | "denied",
): string {
  const proposed = `your proposed Custom Rule [${modeLabels[rule.mode]}] ${JSON.stringify(rule.text)}`;
  return answer === "approved"
    ? `[Approval] The user approved ${proposed}. It is active now, for all their Bots.`
    : `[Approval] The user denied ${proposed}. It was removed. Don't propose it again unless they ask.`;
}

/**
 * Saves the Custom Rule a Turn's `propose_rule` call asked for, `proposed` until the user's
 * Approval, with its `rule` change in each of the user's Bots' threads, and appends the Message
 * that asks for it: the Bot's reason and a `rule_approval` control holding the rule's id, whose
 * state the client reads from the row. One open proposal per Bot: while its earlier one waits for
 * the user's answer, it saves nothing and the result says to wait. In the caller's transaction,
 * under the user's rule locks; the caller hints the threads (`hintRuleChanged`) once it commits.
 * Returns the tool's result.
 */
export async function proposeRule(
  deps: BotSdkContext,
  tx: Transaction,
  {
    botId,
    userId,
    conversationId,
    turnId,
    text,
    mode,
    why,
    now,
  }: {
    botId: string;
    userId: string;
    conversationId: string;
    turnId: string;
    text: string;
    mode: CustomRuleMode;
    why: string;
    now: Date;
  },
): Promise<{ saved: string } | { error: string }> {
  const owned = await lockRules(tx, userId);
  const [open] = await tx
    .select({ id: customRule.id })
    .from(customRule)
    .where(and(eq(customRule.proposedByBotId, botId), eq(customRule.state, "proposed")))
    .limit(1);
  if (open) return { error: openProposalError };
  const id = uuidv7();
  await tx.insert(customRule).values({
    id,
    userId,
    text,
    mode,
    state: "proposed",
    proposedByBotId: botId,
    createdAt: now,
    updatedAt: now,
  });
  for (const owner of owned) await recordBotChange(tx, owner, "rule", id, now);
  await appendBotMessage(deps, tx, conversationId, {
    parts: controlParts(`I'd like to add a Custom Rule: [${modeLabels[mode]}] ${text}\n\n${why}`, {
      kind: "rule_approval",
      ruleId: id,
    }),
    createdAt: now,
    turnId,
  });
  return { saved: ruleProposedResult };
}

/**
 * Wakes the Bot that proposed `rule` with its Approval Trigger, in `tx`. A rule whose Bot is gone
 * (`proposedByBotId` was set null) has no one to wake. Returns whether it woke one.
 */
async function wakeProposer(
  sdk: BotSdkContext,
  tx: Transaction,
  rule: CustomRule,
  answer: "approved" | "denied",
  now: Date,
): Promise<boolean> {
  if (!rule.proposedByBotId) return false;
  const [owner] = await tx
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, rule.proposedByBotId));
  if (!owner) return false;
  await receive(sdk, tx, {
    id: ruleApprovalTriggerId(rule.id),
    conversationId: owner.conversationId,
    source: "approval",
    channel: "web",
    text: ruleApprovalTriggerText(rule, answer),
    receivedAt: now,
  });
  return true;
}

/**
 * Approves the user's proposed rule `ruleId`: it turns `active`, refused past the 50 active rules,
 * and the Bot that proposed it wakes through an Approval Trigger. A rule already active stays as it
 * is and wakes no one. Another user's is not found.
 */
export async function approveRule(
  sdk: BotSdkContext,
  userId: string,
  ruleId: string,
): Promise<CustomRule> {
  let woke = false;
  const approved = await changeRules(sdk, userId, async (tx, now) => {
    const [found] = await tx
      .select(ruleFields)
      .from(customRule)
      .where(and(eq(customRule.id, ruleId), eq(customRule.userId, userId)));
    if (!found) throw notFound();
    if (found.state === "active") return { ruleId, result: found };
    await requireRoom(tx, userId);
    const [active] = await tx
      .update(customRule)
      .set({ state: "active", updatedAt: now })
      .where(eq(customRule.id, ruleId))
      .returning(ruleFields);
    woke = await wakeProposer(sdk, tx, active!, "approved", now);
    return { ruleId, result: active! };
  });
  if (woke) sdk.runner.wake();
  return approved;
}

/**
 * Denies the user's proposed rule `ruleId`: it is deleted, and the Bot that proposed it wakes
 * through an Approval Trigger. An active rule is not a proposal: it stays, and wakes no one.
 * Another user's is not found.
 */
export async function denyRule(sdk: BotSdkContext, userId: string, ruleId: string): Promise<void> {
  let woke = false;
  await changeRules(sdk, userId, async (tx, now) => {
    const [denied] = await tx
      .delete(customRule)
      .where(
        and(
          eq(customRule.id, ruleId),
          eq(customRule.userId, userId),
          eq(customRule.state, "proposed"),
        ),
      )
      .returning(ruleFields);
    if (denied) {
      woke = await wakeProposer(sdk, tx, denied, "denied", now);
      return { ruleId, result: undefined };
    }
    const [kept] = await tx
      .select({ id: customRule.id })
      .from(customRule)
      .where(and(eq(customRule.id, ruleId), eq(customRule.userId, userId)));
    if (!kept) throw notFound();
    return { ruleId, result: undefined };
  });
  if (woke) sdk.runner.wake();
}
