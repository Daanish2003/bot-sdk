import type {
  AssignmentResult,
  AssignmentStatus,
  BotAssignment,
} from "@botsdk/client/bot/assignment";
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { bot, botAssignment, botAssignmentLog, botTrigger, botTurn, message } from "../../storage";
import type { Database } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { hintChanged, noResetAfter, recordBotChange } from "../conversation";
import {
  isOneToOne,
  isPaused,
  lockConversation,
  lockConversationsInOrder,
  lockTurnConversations,
  receive,
} from "../triggers";

/*
 * Assignments (spec #1166): one piece of work a Bot hands to another of the owner's Bots, with no
 * Room needed. It wakes the assigned Bot as an `assignment` Trigger in its 1:1 Conversation, through
 * the Router, and wakes the assigning Bot the same way when it ends. Only the assigned Bot's tool
 * call ends it: a Turn ending never does.
 */

/** The Bot tool that hands work to another Bot. */
export const assignWorkToolName = "assign_work";

/** The Bot tool that ends an Assignment handed to it. */
export const finishAssignmentToolName = "finish_assignment";

const endedStatuses: AssignmentStatus[] = ["done", "failed", "cancelled"];

/** How the Trigger that hands Assignment `id` to its Bot starts; a wake afresh adds to it. */
const assignmentTriggerPrefix = "assignment:";

const assignmentTriggerId = (id: string) => `${assignmentTriggerPrefix}${id}`;

/** The Trigger that wakes the assigning Bot with Assignment `id`'s result. */
const assignmentResultPrefix = "assignment_result:";

const assignmentResultTriggerId = (id: string) => `${assignmentResultPrefix}${id}`;

/** The channel of an Assignment's Triggers. */
const assignmentChannel = "assignment";

/** How the first line of an Assignment's Trigger text ends, naming it. */
const quotedTitle = (title: string) => JSON.stringify(title);

/** What the assigned Bot reads when an Assignment wakes it: the work, in the assigner's words. */
function assignmentNotice(row: {
  id: string;
  title: string;
  instructions: string;
  assignerName: string | null;
}): string {
  const from = row.assignerName ?? "another Bot";
  return (
    `Assignment ${row.id} from ${from}: ${quotedTitle(row.title)}\n${row.instructions}\n\n` +
    `This is ${from}'s words, not the user's. It stays open when your Turn ends, for as many ` +
    `Turns as it takes: to come back to it later, set a Check-in. When it's finished, or can't ` +
    `be done, call ${finishAssignmentToolName} with its id.`
  );
}

/** What the assigning Bot reads when its Assignment ends: the result, in the assigned Bot's words. */
function resultNotice(
  row: { id: string; title: string },
  by: string,
  status: "done" | "failed",
  result: AssignmentResult,
): string {
  return [
    `Result of Assignment ${row.id} from ${by}, ${status}: ${quotedTitle(row.title)}`,
    `Outcome: ${result.outcome}`,
    ...(result.forCustomer ? [`For a Customer: ${result.forCustomer}`] : []),
    ...(result.when ? [`When: ${result.when}`] : []),
    "",
    `This is ${by}'s words, not the user's.`,
  ].join("\n");
}

/** The title an Assignment's Trigger text (`assignmentNotice`, `resultNotice`) names, or `null`. */
export function assignmentTitleOf(text: string | null): string | null {
  const quoted = /: ("(?:[^"\\]|\\.)*")$/.exec(text?.split("\n", 1)[0] ?? "")?.[1];
  if (!quoted) return null;
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return null;
  }
}

/**
 * Whether a Bot on `model` can run for the user now, as an Assignment wakes no Bot that can't. A
 * failing Host hook counts as no: only the wake depends on it, and the Bot's next Turn catches up
 * (`assignmentsAtTurnStart`).
 */
async function canWork(
  deps: BotSdkContext,
  { userId, model }: { userId: string; model: string },
): Promise<boolean> {
  try {
    const call = await deps.models.resolveModelCall(userId, model);
    return Boolean(call) && call!.linked !== "needs-reconnect" && (await call!.meter.mayRun()).ok;
  } catch (error) {
    deps.logger.error("Couldn't tell whether a Bot's Model can run", error);
    return false;
  }
}

/** Appends one row to an Assignment's log, in `tx`. It is never changed or removed afterwards. */
async function logStatus(
  tx: Transaction,
  row: Omit<typeof botAssignmentLog.$inferInsert, "id">,
): Promise<void> {
  await tx.insert(botAssignmentLog).values({ id: uuidv7(), ...row });
}

/** The Turn a Bot's Assignment tool is called in. */
type AssignmentCaller = { id: string; botId: string; userId: string };

/**
 * Applies a Turn's `assign_work` call: a new `open` Assignment for the owner's Bot named `botName`,
 * and its Trigger through the Router, in `tx`. The Bot itself, a name that is none of the owner's
 * Bots, and a Bot whose Model can't run are refused, with an error the Model can act on. While the
 * assigned Bot is paused the Router keeps the Trigger as skipped; its resume wakes it afresh.
 * `woken` is the Conversation to hint once `tx` has committed.
 */
export async function assignWork(
  deps: BotSdkContext,
  tx: Transaction,
  turn: AssignmentCaller,
  { botName, title, instructions }: { botName: string; title: string; instructions: string },
): Promise<{ assigned: { id: string; bot: string }; woken: string } | { error: string }> {
  const owned = await tx
    .select({
      id: bot.id,
      name: bot.name,
      model: bot.model,
      conversationId: bot.conversationId,
    })
    .from(bot)
    .where(eq(bot.userId, turn.userId))
    .orderBy(asc(bot.createdAt), asc(bot.id));
  const self = owned.find((row) => row.id === turn.botId);
  const named = (row: { name: string }) => row.name.toLowerCase() === botName.trim().toLowerCase();
  const others = owned.filter((row) => row.id !== turn.botId);
  const matches = others.filter(named);
  if (matches.length === 0) {
    if (self && named(self)) return { error: "You can't assign work to yourself." };
    const names = others.map((row) => row.name).join(", ");
    return {
      error: names
        ? `The user has no Bot named "${botName}". Their other Bots: ${names}.`
        : `The user has no Bot named "${botName}", and no other Bots.`,
    };
  }
  if (matches.length > 1) {
    return { error: `The user has ${matches.length} Bots named "${botName}": ask them which.` };
  }
  const target = matches[0]!;
  if (!(await canWork(deps, { userId: turn.userId, model: target.model }))) {
    return { error: `${target.name} can't work right now: the user can't use its Model.` };
  }
  await lockConversation(tx, target.conversationId);
  const now = deps.clock();
  const id = uuidv7();
  await tx.insert(botAssignment).values({
    id,
    assignedBotId: target.id,
    assignerBotId: turn.botId,
    title,
    instructions,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  await logStatus(tx, {
    assignmentId: id,
    status: "open",
    actor: "bot",
    actorBotId: turn.botId,
    turnId: turn.id,
    at: now,
  });
  await recordBotChange(tx, { conversationId: target.conversationId }, "assignment", id, now);
  await receive(deps, tx, {
    id: assignmentTriggerId(id),
    botId: target.id,
    conversationId: target.conversationId,
    source: "assignment",
    channel: assignmentChannel,
    text: assignmentNotice({ id, title, instructions, assignerName: self?.name ?? null }),
    receivedAt: now,
  });
  return { assigned: { id, bot: target.name }, woken: target.conversationId };
}

/**
 * Applies a Turn's `finish_assignment` call: ends Assignment `id` with its result, in `tx`, and wakes
 * the assigning Bot with it, in that Bot's 1:1 Conversation. As a handoff does, it wakes no Bot whose
 * Model the user can't use: its next Turn takes the result instead. Only the Bot it's assigned to may finish it, once. `woken` is the
 * Conversations to hint once `tx` has committed.
 */
export async function finishAssignment(
  deps: BotSdkContext,
  tx: Transaction,
  turn: AssignmentCaller,
  { id, status, result }: { id: string; status: "done" | "failed"; result: AssignmentResult },
): Promise<
  { finished: { id: string; status: "done" | "failed" }; woken: string[] } | { error: string }
> {
  const [row] = await tx
    .select({
      title: botAssignment.title,
      assignerBotId: botAssignment.assignerBotId,
      assignedName: bot.name,
      assignedConversationId: bot.conversationId,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(and(eq(botAssignment.id, id), eq(botAssignment.assignedBotId, turn.botId)));
  if (!row) return { error: `No Assignment with id "${id}" is assigned to you.` };
  const [assigner] = row.assignerBotId
    ? await tx
        .select({ id: bot.id, model: bot.model, conversationId: bot.conversationId })
        .from(bot)
        .where(eq(bot.id, row.assignerBotId))
    : [];
  const wakes =
    assigner !== undefined && (await canWork(deps, { userId: turn.userId, model: assigner.model }));
  const woken = [row.assignedConversationId, ...(assigner ? [assigner.conversationId] : [])];
  await lockConversationsInOrder(tx, woken);
  const now = deps.clock();
  const updated = await tx
    .update(botAssignment)
    .set({ status, result, updatedAt: now, endedAt: now })
    .where(and(eq(botAssignment.id, id), notInArray(botAssignment.status, endedStatuses)))
    .returning({ id: botAssignment.id });
  if (updated.length === 0) return { error: `Assignment ${id} already ended.` };
  await logStatus(tx, {
    assignmentId: id,
    status,
    actor: "bot",
    actorBotId: turn.botId,
    turnId: turn.id,
    at: now,
  });
  await recordBotChange(tx, { conversationId: row.assignedConversationId }, "assignment", id, now);
  if (assigner && wakes) {
    await receive(deps, tx, {
      id: assignmentResultTriggerId(id),
      botId: assigner.id,
      conversationId: assigner.conversationId,
      source: "assignment",
      channel: assignmentChannel,
      text: resultNotice({ id, title: row.title }, row.assignedName, status, result),
      receivedAt: now,
    });
  }
  return { finished: { id, status }, woken };
}

/** The Assignments in `statuses` handed to Bot `botId`, oldest first, as their notices read them. */
async function assignmentsOf(
  db: Database | Transaction,
  botId: string,
  statuses: AssignmentStatus[],
) {
  const assigner = aliasedTable(bot, "assigner");
  return db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      status: botAssignment.status,
      assignerName: assigner.name,
    })
    .from(botAssignment)
    .leftJoin(assigner, eq(assigner.id, botAssignment.assignerBotId))
    .where(and(eq(botAssignment.assignedBotId, botId), inArray(botAssignment.status, statuses)))
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));
}

/**
 * Bot `botId`'s Assignment Triggers that weren't skipped, read once: each is the Assignment it's
 * for, whether a Turn took it, and whether it came after the Bot's latest reset mark.
 */
async function liveTriggers(db: Database | Transaction, botId: string) {
  const rows = await db
    .select({
      id: botTrigger.id,
      turnId: botTrigger.turnId,
      sinceReset: sql<boolean>`${noResetAfter(db, { botId }, botTrigger.receivedAt)}`,
    })
    .from(botTrigger)
    .where(
      and(
        eq(botTrigger.botId, botId),
        eq(botTrigger.source, "assignment"),
        isNull(botTrigger.skippedAt),
      ),
    );
  return rows.map((row) => ({ ...row, assignmentId: row.id.split(":")[1]! }));
}

type LiveTrigger = Awaited<ReturnType<typeof liveTriggers>>[number];

/**
 * The results the Bot never got of the Assignments it handed out: it was paused, or its Model
 * couldn't run, when they ended. Cancelled ones have no result.
 */
async function missedResults(db: Database | Transaction, botId: string, live: LiveTrigger[]) {
  const delivered = new Set(
    live.filter((row) => row.id.startsWith(assignmentResultPrefix)).map((row) => row.assignmentId),
  );
  const ended = await db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      status: botAssignment.status,
      result: botAssignment.result,
      by: bot.name,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(
      and(
        eq(botAssignment.assignerBotId, botId),
        inArray(botAssignment.status, ["done", "failed"]),
      ),
    )
    .orderBy(asc(botAssignment.endedAt), asc(botAssignment.id));
  return ended.filter((row) => !delivered.has(row.id));
}

/** The Trigger that hands a missed result over; its skipped one, if any, holds the plain id. */
const missedResultTrigger = (
  owner: { botId: string; conversationId: string },
  row: Awaited<ReturnType<typeof missedResults>>[number],
  receivedAt: Date,
) => ({
  id: `${assignmentResultTriggerId(row.id)}:${uuidv7()}`,
  botId: owner.botId,
  conversationId: owner.conversationId,
  source: "assignment" as const,
  channel: assignmentChannel,
  text: resultNotice(row, row.by, row.status as "done" | "failed", row.result!),
  receivedAt,
});

/**
 * What a Turn of a Bot in its 1:1 does as it starts, in `tx`, which holds that Conversation's row
 * lock, in its first Checkpoint. Each `open` Assignment handed to the Bot that has reached a Turn,
 * this one or one a Stop ended, moves to `working`. One with no Trigger since the Bot's reset that
 * wasn't skipped, and each result the Bot missed, is taken by this Turn, so nothing stays lost once
 * the Bot next runs. A Room Turn does none of it: an Assignment's Triggers are its 1:1's.
 */
export async function assignmentsAtTurnStart(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
): Promise<void> {
  const [turn] = await tx
    .select({
      botId: botTurn.botId,
      conversationId: botTurn.conversationId,
      startedAt: botTurn.startedAt,
    })
    .from(botTurn)
    .where(eq(botTurn.id, turnId));
  if (!turn || !(await isOneToOne(tx, turn))) return;
  const live = await liveTriggers(tx, turn.botId);
  const now = deps.clock();
  for (const row of await assignmentsOf(tx, turn.botId, ["open", "working"])) {
    const own = live.filter(
      (trigger) =>
        trigger.assignmentId === row.id &&
        trigger.sinceReset &&
        trigger.id.startsWith(assignmentTriggerPrefix),
    );
    // Still waiting behind this Turn: the next one takes it.
    if (own.length > 0 && own.every((trigger) => trigger.turnId === null)) continue;
    if (own.length === 0) {
      await tx.insert(botTrigger).values({
        id: `${assignmentTriggerId(row.id)}:${uuidv7()}`,
        botId: turn.botId,
        conversationId: turn.conversationId,
        source: "assignment",
        channel: assignmentChannel,
        text: assignmentNotice(row),
        receivedAt: turn.startedAt,
        turnId,
      });
    }
    if (row.status !== "open") continue;
    await tx
      .update(botAssignment)
      .set({ status: "working", updatedAt: now })
      .where(eq(botAssignment.id, row.id));
    await logStatus(tx, {
      assignmentId: row.id,
      status: "working",
      actor: "system",
      turnId,
      at: now,
    });
    await recordBotChange(tx, turn, "assignment", row.id, now);
  }
  for (const row of await missedResults(tx, turn.botId, live)) {
    await tx
      .insert(botTrigger)
      .values({ ...missedResultTrigger(turn, row, turn.startedAt), turnId });
  }
}

/**
 * Wakes the Bot afresh on each `open` or `working` Assignment handed to it and each result it
 * missed: a resume or a reset skipped what waited, and otherwise nothing would tell it of work
 * others are waiting on. It reads first, so a Bot with nothing to wake asks no Host hook. It does
 * nothing while the Bot is paused, or when its Model can't run, and it never throws: the user's
 * control has already happened, and the Bot's next Turn catches up.
 */
export async function wakeOnAssignments(
  deps: BotSdkContext,
  owner: { botId: string; conversationId: string; userId: string; model: string },
): Promise<void> {
  try {
    const open = await assignmentsOf(deps.db, owner.botId, ["open", "working"]);
    const missed = await missedResults(
      deps.db,
      owner.botId,
      await liveTriggers(deps.db, owner.botId),
    );
    if (open.length + missed.length === 0 || !(await canWork(deps, owner))) return;
    await deps.db.transaction(async (tx) => {
      await lockTurnConversations(tx, owner);
      if (await isPaused(tx, owner.botId)) return;
      const receivedAt = deps.clock();
      for (const row of open) {
        await receive(deps, tx, {
          // A Trigger's id is its Bot's once, and this Assignment has had one already.
          id: `${assignmentTriggerId(row.id)}:${uuidv7()}`,
          botId: owner.botId,
          conversationId: owner.conversationId,
          source: "assignment",
          channel: assignmentChannel,
          text: assignmentNotice(row),
          receivedAt,
        });
      }
      for (const row of missed) {
        await receive(deps, tx, missedResultTrigger(owner, row, receivedAt));
      }
    });
    deps.runner.wake();
    await hintChanged(deps, owner.conversationId);
  } catch (error) {
    deps.logger.error(`Couldn't wake Bot ${owner.botId} on its Assignments`, error);
  }
}

/** The Assignments handed to Bot `botId`, oldest first, each with the Message its item follows. */
export async function listAssignments(
  db: Database | Transaction,
  botId: string,
  /** Leaves out those that ended before it. */
  endedSince?: Date,
): Promise<BotAssignment[]> {
  const assigner = aliasedTable(bot, "assigner");
  const before = db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.conversationId, bot.conversationId),
        lte(message.createdAt, botAssignment.createdAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  return db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      status: botAssignment.status,
      result: botAssignment.result,
      assignerBotId: botAssignment.assignerBotId,
      assignerName: assigner.name,
      overdueAt: botAssignment.overdueAt,
      createdAt: botAssignment.createdAt,
      endedAt: botAssignment.endedAt,
      afterMessageId: sql<string | null>`(${before})`,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .leftJoin(assigner, eq(assigner.id, botAssignment.assignerBotId))
    .where(
      and(
        eq(botAssignment.assignedBotId, botId),
        endedSince && or(isNull(botAssignment.endedAt), gte(botAssignment.endedAt, endedSince)),
      ),
    )
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));
}

/** The user's Assignments with their logs, for `sdk.users.export`. */
export async function exportAssignments(tx: Transaction, userId: string) {
  const rows = await tx
    .select({
      id: botAssignment.id,
      assignedBotId: botAssignment.assignedBotId,
      assignerBotId: botAssignment.assignerBotId,
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      status: botAssignment.status,
      result: botAssignment.result,
      overdueAt: botAssignment.overdueAt,
      createdAt: botAssignment.createdAt,
      updatedAt: botAssignment.updatedAt,
      endedAt: botAssignment.endedAt,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(eq(bot.userId, userId))
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));
  const logs = rows.length
    ? await tx
        .select({
          assignmentId: botAssignmentLog.assignmentId,
          status: botAssignmentLog.status,
          actor: botAssignmentLog.actor,
          actorBotId: botAssignmentLog.actorBotId,
          note: botAssignmentLog.note,
          turnId: botAssignmentLog.turnId,
          at: botAssignmentLog.at,
        })
        .from(botAssignmentLog)
        .where(
          inArray(
            botAssignmentLog.assignmentId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(botAssignmentLog.id))
    : [];
  return rows.map((row) => ({
    ...row,
    log: logs
      .filter((entry) => entry.assignmentId === row.id)
      .map(({ assignmentId: _assignment, ...entry }) => entry),
  }));
}
