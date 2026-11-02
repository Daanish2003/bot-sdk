import {
  assignmentMoney,
  type AssignmentBudget,
  isEndedAssignment,
  isOverBudget,
} from "@botsdk/client/bot/assignment";
import { aliasedTable, and, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { BotSdkContext, Transaction } from "../../plugin";
import type { WorkflowContext } from "../../runner/internal";
import { bot, botAssignment, botTrigger } from "../../storage";
import type { Database } from "../../storage";
import { appendBotMessage, hintChanged, recordBotChange, textParts } from "../conversation";
import { lockConversationSet, lockConversationsInOrder, receive } from "../triggers";
import {
  assignmentsOf,
  assignmentsOfTurn,
  assignmentTrigger,
  botsThatCanWork,
  budgetsOf,
  endedStatuses,
  logStatus,
  onBotsOpenAssignments,
  openDescendants,
} from "./assignment";

/*
 * An Assignment's budget (#1184): a limit on model calls, which holds on the user's own key where
 * cost is $0 (ADR 0007), and on money, where a price is known. The budget is the top Assignment's:
 * its descendants draw from it, so splitting work can't escape it. It is checked before each model
 * call of a Turn working on an Assignment, and a call already started finishes.
 */

/** How a Turn's loop keeps to the budgets of the Assignments it's working on. */
export type LoopBudget = {
  /**
   * In its own Checkpoint, before each model call: `stop` ends the loop there, and `note` is what
   * the Model is told when the Turn carries on for what else it took.
   */
  check: (tx: Transaction) => Promise<{ stop: boolean; note?: string }>;
  /** Runs after each check, once its Checkpoint has committed (and on its replay). */
  afterCheck: () => Promise<void>;
  /** Counts one model call, in its bill's Checkpoint transaction. */
  spend: (tx: Transaction, costMicros: number) => Promise<void>;
};

/** How a budget stands, in words. */
const spent = (budget: AssignmentBudget) =>
  `${budget.calls} of ${budget.callLimit} model calls, ` +
  `${assignmentMoney(budget.costMicros)} of ${assignmentMoney(budget.moneyLimitMicros)}`;

/** The Assignments a Turn is on, and how the budgets it draws from stand. */
async function budgetsOfTurn(tx: Transaction, turn: { id: string; botId: string }) {
  const { on, ended, sources, apart, uncharged } = await assignmentsOfTurn(tx, turn);
  const ids = [...on.keys()].filter((id) => !uncharged.has(id));
  const budgets = await budgetsOf(tx, ids);
  const budget = (id: string) => budgets.get(id)!.budget;
  // One already over budget takes no more spend, whatever else this Turn is for.
  const live = ids.filter((id) => !budget(id).overBudget);
  const over = live.filter((id) => isOverBudget(budget(id)));
  // A Step after the Bot's child ended still costs: it would otherwise escape its parent's budget,
  // one finish at a time. Such a child takes no more spend rows, so the row goes on the top one, and
  // with that ended too there is no budget left to keep to.
  const endedBudgets = await budgetsOf(tx, ended);
  const tops = await budgetsOf(tx, [...new Set(ended.map((id) => endedBudgets.get(id)!.rootId))]);
  const drawnFrom = [...tops.keys()].filter((id) => !isEndedAssignment(tops.get(id)!.status));
  const paid = new Set(live.map((id) => budgets.get(id)!.rootId));
  // A Trigger of anything else (the user's Message, a Routine's run, the user's answer to an
  // Approval) still gets its Turn, as does a result that no open Assignment of the Bot's stands
  // behind. A Check-in's or a Helper's report doesn't stand apart: such a Turn is taken as work on
  // the Bot's open Assignments, and otherwise a Bot could work on past the limit. The Trigger stays
  // in the Bot's history, so its next Turn reads it.
  const onlyWork =
    !apart &&
    [...sources].every(
      (source) => source === "assignment" || source === "check_in" || source === "helper",
    );
  const nothingLeft = ids.length > 0 && live.length === 0;
  const finishedOver =
    ids.length === 0 && drawnFrom.some((id) => isOverBudget(tops.get(id)!.budget));
  return {
    budgets: new Map([...budgets, ...tops]),
    live,
    over,
    charged: [...live, ...drawnFrom.filter((id) => !paid.has(id))],
    onlyWork,
    acts: over.length > 0 || (onlyWork && (nothingLeft || finishedOver)),
  };
}

/**
 * The budget a Turn's loop keeps to, or `undefined` for a Turn that can't be working on an
 * Assignment, which then runs with no check at all: one with no Assignment Trigger, unless no user
 * asked for it and it follows on from the Bot's work, so it's on the Bot's open ones
 * (`onBotsOpenAssignments`). The
 * Triggers it started with don't change, so each attempt answers the same. A Room Turn has none.
 */
export async function turnBudget(
  deps: BotSdkContext,
  turn: { id: string; botId: string; conversationId: string; startedAt: Date },
  ctx: WorkflowContext<Transaction>,
  db: Database | Transaction,
): Promise<LoopBudget | undefined> {
  const triggers = await db
    .select({ source: botTrigger.source })
    .from(botTrigger)
    .innerJoin(
      bot,
      and(eq(bot.id, botTrigger.botId), eq(bot.conversationId, botTrigger.conversationId)),
    )
    // A Stop attaches what waited behind the Turn to it, which a replay must not read as its own.
    .where(and(eq(botTrigger.turnId, turn.id), lte(botTrigger.receivedAt, turn.startedAt)));
  const sources = new Set<string>(triggers.map((row) => row.source));
  if (!sources.has("assignment") && !onBotsOpenAssignments(sources)) return undefined;
  // Such a Turn that was running before budgets existed recorded no checks.
  if (!(await ctx.patched("assignment_budget"))) return undefined;
  // Set only by a live check: a replayed one changed nothing.
  const hints = new Set<string>();
  return {
    check: async (tx) => {
      if (!(await budgetsOfTurn(tx, turn)).acts) return { stop: false };
      // A parent's thread shows its children, so it's told of a child going over too.
      const parents = aliasedTable(bot, "parent_bot");
      const parent = aliasedTable(botAssignment, "parent");
      const threads = await tx
        .select({ id: botAssignment.id, conversationId: parents.conversationId })
        .from(botAssignment)
        .innerJoin(parent, eq(parent.id, botAssignment.parentAssignmentId))
        .innerJoin(parents, eq(parents.id, parent.assignedBotId))
        .where(eq(botAssignment.assignedBotId, turn.botId));
      await lockConversationsInOrder(tx, [
        ...new Set([turn.conversationId, ...threads.map((row) => row.conversationId)]),
      ]);
      // Read again: the owner may have raised the limit before the lock came.
      const { acts, budgets, live, over, onlyWork } = await budgetsOfTurn(tx, turn);
      if (!acts) return { stop: false };
      const now = deps.clock();
      const notes: string[] = [];
      const rows = await assignmentsOf(tx, turn.botId, ["open", "working", "blocked"]);
      for (const row of rows.filter((row) => over.includes(row.id))) {
        const budget = budgets.get(row.id)!.budget;
        await tx
          .update(botAssignment)
          .set({ status: "blocked", overBudgetAt: now, updatedAt: now })
          .where(eq(botAssignment.id, row.id));
        await logStatus(tx, {
          assignmentId: row.id,
          status: "blocked",
          actor: "system",
          note: `Out of budget: ${spent(budget)}. Waiting on the user.`,
          turnId: turn.id,
          at: now,
        });
        await recordBotChange(tx, turn, "assignment", row.id, now);
        for (const thread of threads.filter((thread) => thread.id === row.id)) {
          await recordBotChange(tx, thread, "assignment", row.id, now);
          hints.add(thread.conversationId);
        }
        await appendBotMessage(deps, tx, turn, {
          parts: textParts(
            // A feature's title is untrusted, and the Bot reads its own Messages: only its id goes in.
            `Assignment ${row.assignerTrusted ? JSON.stringify(row.title) : row.id} is out of budget: ${spent(budget)}. ` +
              "Raise its limit or cancel it.",
          ),
          createdAt: now,
          turnId: turn.id,
        });
        notes.push(
          `Assignment ${row.id} is out of budget and blocked until the user raises its limit. ` +
            "Do no more work on it now.",
        );
      }
      hints.add(turn.conversationId);
      if (!onlyWork) return { stop: false, note: notes.join("\n") };
      // The Turn stops for all it took, so the Bot is woken afresh on those with budget left.
      for (const row of rows) {
        if (over.includes(row.id) || !live.includes(row.id) || row.status === "blocked") continue;
        await receive(deps, tx, assignmentTrigger(row, turn, now));
      }
      return { stop: true };
    },
    afterCheck: async () => {
      for (const conversationId of hints) await hintChanged(deps, conversationId);
      hints.clear();
    },
    spend: async (tx, costMicros) => {
      const { budgets, charged } = await budgetsOfTurn(tx, turn);
      const at = deps.clock();
      for (const id of charged) {
        const { rootId, status } = budgets.get(id)!;
        await tx
          .update(botAssignment)
          .set({
            callsSpent: sql`${botAssignment.callsSpent} + 1`,
            microsSpent: sql`${botAssignment.microsSpent} + ${costMicros}`,
          })
          .where(eq(botAssignment.id, rootId));
        await logStatus(tx, {
          assignmentId: id,
          status,
          actor: "system",
          turnId: turn.id,
          calls: 1,
          costMicros,
          at,
        });
      }
    },
  };
}

/**
 * The owner raises the budget Assignment `id` draws from, in `tx`. Once it has room, every
 * Assignment on that budget that was over it stops being so: those with no open child go back to
 * `working` and their Bots are woken. A raise that leaves the other limit spent is kept, and blocks
 * stay. A wake needs a Model the user can use, so a Bot that can't run refuses the raise, as nothing
 * would wake it later. `woken` is the Conversations to hint once `tx` has committed.
 */
export async function raiseAssignmentLimit(
  deps: BotSdkContext,
  tx: Transaction,
  owner: { userId: string; botId: string },
  {
    id,
    callLimit,
    moneyLimitMicros,
  }: { id: string; callLimit?: number; moneyLimitMicros?: number },
): Promise<{ woken: string[] } | { reason: "not_found" | "ended" | "lowered" | "cant_run" }> {
  const [found] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(
      and(
        eq(botAssignment.id, id),
        eq(botAssignment.assignedBotId, owner.botId),
        eq(bot.userId, owner.userId),
      ),
    );
  if (!found) return { reason: "not_found" };
  const rootId = (await budgetsOf(tx, [id])).get(id)!.rootId;
  const parent = alias(botAssignment, "parent");
  const parentBot = alias(bot, "parent_bot");
  /** The Assignments on this budget that are over it, read with their Bots and parents' threads. */
  const overOf = async (db: Transaction) => {
    const rows = await db
      .select({
        id: botAssignment.id,
        assignedBotId: botAssignment.assignedBotId,
        assignedModel: bot.model,
        assignedConversationId: bot.conversationId,
        status: botAssignment.status,
        parentId: botAssignment.parentAssignmentId,
        parentConversationId: parentBot.conversationId,
      })
      .from(botAssignment)
      .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
      .leftJoin(parent, eq(parent.id, botAssignment.parentAssignmentId))
      .leftJoin(parentBot, eq(parentBot.id, parent.assignedBotId))
      .where(
        and(
          inArray(botAssignment.id, [
            rootId,
            ...(await openDescendants(db, rootId)).map((row) => row.id),
          ]),
          isNotNull(botAssignment.overBudgetAt),
          notInArray(botAssignment.status, endedStatuses),
        ),
      );
    return rows;
  };
  // Asked before the locks. A Bot that went over since has just run, so it isn't refused.
  const asked = await overOf(tx);
  const tellable = await botsThatCanWork(deps, owner.userId, asked);
  const cantRun = new Set(
    asked.flatMap((row) => (tellable.has(row.assignedBotId) ? [] : [row.assignedBotId])),
  );
  const woken = await lockConversationSet(tx, async (db) => {
    const [root] = await db
      .select({ conversationId: bot.conversationId })
      .from(botAssignment)
      .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
      .where(eq(botAssignment.id, rootId));
    return [
      ...new Set([
        root!.conversationId,
        ...(await openDescendants(db, rootId)).map((row) => row.assignedConversationId),
      ]),
    ];
  });
  const [before] = await tx
    .select({
      calls: botAssignment.callsSpent,
      callLimit: botAssignment.callLimit,
      costMicros: botAssignment.microsSpent,
      moneyLimitMicros: botAssignment.moneyLimitMicros,
    })
    .from(botAssignment)
    .where(eq(botAssignment.id, rootId));
  const [target] = await tx
    .select({ status: botAssignment.status })
    .from(botAssignment)
    .where(eq(botAssignment.id, id));
  if (isEndedAssignment(target!.status)) return { reason: "ended" };
  if (
    (callLimit !== undefined && callLimit <= before!.callLimit) ||
    (moneyLimitMicros !== undefined && moneyLimitMicros <= before!.moneyLimitMicros)
  ) {
    return { reason: "lowered" };
  }
  const budget = {
    ...before!,
    ...(callLimit && { callLimit }),
    ...(moneyLimitMicros && { moneyLimitMicros }),
    overBudget: false,
  };
  const note = `Limit raised to ${budget.callLimit} model calls and ${assignmentMoney(budget.moneyLimitMicros)}.`;
  const over = isOverBudget(budget) ? [] : await overOf(tx);
  const waitingOn = new Set(
    over.length === 0
      ? []
      : (
          await tx
            .select({ parent: botAssignment.parentAssignmentId })
            .from(botAssignment)
            .where(
              and(
                inArray(
                  botAssignment.parentAssignmentId,
                  over.map((row) => row.id),
                ),
                notInArray(botAssignment.status, endedStatuses),
              ),
            )
        ).map((row) => row.parent),
  );
  // One still waiting on a child needs no wake, so its Bot needn't run yet.
  const freed = over.map((row) => ({ ...row, child: waitingOn.has(row.id) }));
  if (freed.some((row) => !row.child && cantRun.has(row.assignedBotId))) {
    return { reason: "cant_run" };
  }
  const now = deps.clock();
  await tx
    .update(botAssignment)
    .set({ callLimit: budget.callLimit, moneyLimitMicros: budget.moneyLimitMicros })
    .where(eq(botAssignment.id, rootId));
  for (const row of freed) {
    const status = row.child ? ("blocked" as const) : ("working" as const);
    await tx
      .update(botAssignment)
      .set({ status, overBudgetAt: null, updatedAt: now })
      .where(eq(botAssignment.id, row.id));
    await logStatus(tx, { assignmentId: row.id, status, actor: "user", note, at: now });
    await recordBotChange(
      tx,
      { conversationId: row.assignedConversationId },
      "assignment",
      row.id,
      now,
    );
    // A parent's thread shows its children, and it's locked with the budget's other open ones.
    if (row.parentId && row.parentConversationId) {
      await recordBotChange(
        tx,
        { conversationId: row.parentConversationId },
        "assignment",
        row.parentId,
        now,
      );
    }
    if (row.child) continue;
    const [notice] = await assignmentsOf(tx, row.assignedBotId, ["working"], row.id);
    await receive(
      deps,
      tx,
      assignmentTrigger(
        notice!,
        { botId: row.assignedBotId, conversationId: row.assignedConversationId },
        now,
      ),
    );
  }
  if (!freed.some((row) => row.id === id)) {
    await logStatus(tx, {
      assignmentId: id,
      status: target!.status,
      actor: "user",
      note,
      at: now,
    });
    await recordBotChange(tx, found, "assignment", id, now);
  }
  return { woken };
}
