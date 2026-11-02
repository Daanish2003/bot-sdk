import {
  assignmentTriggerPrefix,
  type AssignmentLogEntry,
  type AssignmentResult,
  type AssignmentStatus,
  type BotAssignment,
} from "@botsdk/client/bot/assignment";
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
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

/** The id of the Trigger that hands Assignment `id` to its Bot; a wake afresh adds to it. */
const assignmentTriggerId = (id: string) => `${assignmentTriggerPrefix}${id}`;

/** The Trigger that wakes the assigning Bot with Assignment `id`'s result. */
const assignmentResultPrefix = "assignment_result:";

const assignmentResultTriggerId = (id: string) => `${assignmentResultPrefix}${id}`;

/** How the Trigger that tells a Bot an Assignment was cancelled starts. */
const assignmentCancelPrefix = "assignment_cancel:";

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
  if (updated.length === 0) {
    // Read again: a cancel may have committed since `row` was read.
    const [now] = await tx
      .select({ status: botAssignment.status })
      .from(botAssignment)
      .where(eq(botAssignment.id, id));
    return {
      error:
        now?.status === "cancelled"
          ? `Assignment ${id} was cancelled, so it can't be finished. Stop work on it.`
          : `Assignment ${id} already ended.`,
    };
  }
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

/** A notice the Bot never got, under the id its Trigger would have had. */
type Missed = { id: string; text: string };

/**
 * What the Bot never got of its Assignments: it was paused, or its Model couldn't run, when the
 * result came or the Assignment was cancelled. The results are of those it handed out. A cancel is
 * owed to the assigner when the user cancelled it, as a Bot knows of its own, and to the assigned
 * Bot once a Turn of it had read the work.
 */
async function missedResults(
  db: Database | Transaction,
  botId: string,
  live: LiveTrigger[],
): Promise<Missed[]> {
  const delivered = (prefix: string) =>
    new Set(live.filter((row) => row.id.startsWith(prefix)).map((row) => row.assignmentId));
  const results = delivered(assignmentResultPrefix);
  const cancels = delivered(assignmentCancelPrefix);
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
  const cancelled = await db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      assignerBotId: botAssignment.assignerBotId,
      byUser: sql<boolean>`exists (select 1 from ${botAssignmentLog} where ${botAssignmentLog.assignmentId} = ${botAssignment.id} and ${botAssignmentLog.status} = 'cancelled' and ${botAssignmentLog.actor} = 'user')`,
      read: sql<boolean>`exists (select 1 from ${botTrigger} where ${botTrigger.botId} = ${botAssignment.assignedBotId} and ${botTrigger.source} = 'assignment' and ${botTrigger.id} like ${assignmentTriggerPrefix} || ${botAssignment.id} || '%' and ${botTrigger.turnId} is not null)`,
      assignedBotId: botAssignment.assignedBotId,
    })
    .from(botAssignment)
    // The join makes the columns above table-qualified, as the subqueries need.
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(
      and(
        eq(botAssignment.status, "cancelled"),
        or(eq(botAssignment.assignerBotId, botId), eq(botAssignment.assignedBotId, botId)),
      ),
    )
    .orderBy(asc(botAssignment.endedAt), asc(botAssignment.id));
  const owed = cancelled.filter(
    (row) => !cancels.has(row.id) && (row.assignedBotId === botId ? row.read : row.byUser),
  );
  const assignerIds = owed.flatMap((row) => (row.assignerBotId ? [row.assignerBotId] : []));
  const assigners = assignerIds.length
    ? await db.select({ id: bot.id, name: bot.name }).from(bot).where(inArray(bot.id, assignerIds))
    : [];
  return [
    ...ended
      .filter((row) => !results.has(row.id))
      .map((row) => ({
        id: assignmentResultTriggerId(row.id),
        text: resultNotice(row, row.by, row.status as "done" | "failed", row.result!),
      })),
    ...owed.map((row) => ({
      id: cancelTriggerId(row.id),
      text: cancelNotice(
        row,
        row.byUser
          ? "the user"
          : (assigners.find((assigner) => assigner.id === row.assignerBotId)?.name ??
              "another Bot"),
      ),
    })),
  ];
}

/** The Trigger that hands a missed notice over; its skipped one, if any, holds the plain id. */
const missedResultTrigger = (
  owner: { botId: string; conversationId: string },
  row: Missed,
  receivedAt: Date,
) => ({
  id: `${row.id}:${uuidv7()}`,
  botId: owner.botId,
  conversationId: owner.conversationId,
  source: "assignment" as const,
  channel: assignmentChannel,
  text: row.text,
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
  const rows: Omit<BotAssignment, "log">[] = await db
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
  const logs = await logsOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, log: logs.get(row.id) ?? [] }));
}

/** The log of each Assignment in `ids`, oldest first, as the owner reads it. */
async function logsOf(
  db: Database | Transaction,
  ids: string[],
): Promise<Map<string, AssignmentLogEntry[]>> {
  const logs = new Map<string, AssignmentLogEntry[]>();
  if (ids.length === 0) return logs;
  const rows = await db
    .select({
      assignmentId: botAssignmentLog.assignmentId,
      id: botAssignmentLog.id,
      status: botAssignmentLog.status,
      actor: botAssignmentLog.actor,
      actorName: bot.name,
      note: botAssignmentLog.note,
      turnId: botAssignmentLog.turnId,
      at: botAssignmentLog.at,
    })
    .from(botAssignmentLog)
    .leftJoin(bot, eq(bot.id, botAssignmentLog.actorBotId))
    .where(inArray(botAssignmentLog.assignmentId, ids))
    .orderBy(asc(botAssignmentLog.at), asc(botAssignmentLog.id));
  for (const { assignmentId, ...entry } of rows) {
    logs.set(assignmentId, [...(logs.get(assignmentId) ?? []), entry]);
  }
  return logs;
}

/** The Bot tool that adds a note to the log of an Assignment handed to it. */
export const addAssignmentNoteToolName = "add_assignment_note";

/** The Bot tool that reads the status and log of the Assignments a Bot is part of. */
export const readAssignmentToolName = "read_assignment";

/** The Bot tool that cancels an Assignment the Bot started. */
export const cancelAssignmentToolName = "cancel_assignment";

/** The Trigger that tells a Bot waiting on, or working on, Assignment `id` that it was cancelled. */
const cancelTriggerId = (id: string) => `${assignmentCancelPrefix}${id}`;

/** What a Bot reads when its Assignment was cancelled. */
function cancelNotice(row: { id: string; title: string }, by: string): string {
  return (
    `Assignment ${row.id} was cancelled by ${by}: ${quotedTitle(row.title)}\n` +
    `Stop work on it: ${finishAssignmentToolName} on it is refused.`
  );
}

/** Who cancels an Assignment: the owner, from one of their Bots' pages, or a Bot in a Turn. */
export type AssignmentCanceller =
  | { by: "user"; userId: string; botId: string }
  | { by: "bot"; turn: AssignmentCaller };

/**
 * Cancels Assignment `id`, in `tx`: it moves to `cancelled`, the log gets a row, and a Trigger of
 * its Bot that no Turn has taken yet is skipped, so a cancel while it waits behind another Turn
 * causes no more work. The Bot is told only if a Turn had read it, and the assigning Bot is woken
 * when the owner cancels, as it waits on the result; both only if their Model can run. The owner
 * may cancel any Assignment of their Bot, a Bot only those it started; anything else is `not_found`.
 * `woken` is the Conversations to hint once `tx` has committed.
 */
export async function cancelAssignment(
  deps: BotSdkContext,
  tx: Transaction,
  canceller: AssignmentCanceller,
  id: string,
): Promise<
  { cancelled: { id: string }; woken: string[] } | { error: string; reason: "not_found" | "ended" }
> {
  const [found] = await tx
    .select({
      title: botAssignment.title,
      assignedBotId: botAssignment.assignedBotId,
      assignedUserId: bot.userId,
      assignedModel: bot.model,
      assignedConversationId: bot.conversationId,
      assignerBotId: botAssignment.assignerBotId,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(eq(botAssignment.id, id));
  const [assigner] = found?.assignerBotId
    ? await tx
        .select({ name: bot.name, model: bot.model, conversationId: bot.conversationId })
        .from(bot)
        .where(eq(bot.id, found.assignerBotId))
    : [];
  const row = found && {
    ...found,
    assignerName: assigner?.name,
    assignerModel: assigner?.model,
    assignerConversationId: assigner?.conversationId,
  };
  if (
    !row ||
    !(canceller.by === "user"
      ? row.assignedUserId === canceller.userId && row.assignedBotId === canceller.botId
      : row.assignerBotId === canceller.turn.botId)
  ) {
    return {
      reason: "not_found",
      error:
        canceller.by === "user"
          ? "Assignment not found"
          : `No Assignment with id "${id}" was started by you.`,
    };
  }
  const by = canceller.by === "user" ? "the user" : (row.assignerName ?? "another Bot");
  const owner = { userId: row.assignedUserId };
  const tellsAssigned = await canWork(deps, { ...owner, model: row.assignedModel });
  const wakesAssigner =
    canceller.by === "user" &&
    row.assignerBotId !== null &&
    assigner !== undefined &&
    (await canWork(deps, { ...owner, model: assigner.model }));
  const woken = [
    row.assignedConversationId,
    ...(row.assignerConversationId ? [row.assignerConversationId] : []),
  ];
  await lockConversationsInOrder(tx, woken);
  const now = deps.clock();
  const updated = await tx
    .update(botAssignment)
    .set({ status: "cancelled", updatedAt: now, endedAt: now })
    .where(and(eq(botAssignment.id, id), notInArray(botAssignment.status, endedStatuses)))
    .returning({ id: botAssignment.id });
  if (updated.length === 0) {
    return { reason: "ended", error: `Assignment ${id} already ended.` };
  }
  await logStatus(tx, {
    assignmentId: id,
    status: "cancelled",
    actor: canceller.by,
    actorBotId: canceller.by === "bot" ? canceller.turn.botId : null,
    turnId: canceller.by === "bot" ? canceller.turn.id : null,
    at: now,
  });
  const ofIt = and(
    eq(botTrigger.botId, row.assignedBotId),
    eq(botTrigger.source, "assignment"),
    like(botTrigger.id, `${assignmentTriggerId(id)}%`),
  );
  await tx
    .update(botTrigger)
    .set({ skippedAt: now, skipReason: "cancelled" })
    .where(and(ofIt, isNull(botTrigger.turnId), isNull(botTrigger.skippedAt)));
  const [read] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(and(ofIt, isNotNull(botTrigger.turnId)))
    .limit(1);
  await recordBotChange(tx, { conversationId: row.assignedConversationId }, "assignment", id, now);
  if (read && tellsAssigned) {
    await receive(deps, tx, {
      id: cancelTriggerId(id),
      botId: row.assignedBotId,
      conversationId: row.assignedConversationId,
      source: "assignment",
      channel: assignmentChannel,
      text: cancelNotice({ id, title: row.title }, by),
      receivedAt: now,
    });
  }
  if (wakesAssigner) {
    await receive(deps, tx, {
      id: cancelTriggerId(id),
      botId: row.assignerBotId!,
      conversationId: row.assignerConversationId!,
      source: "assignment",
      channel: assignmentChannel,
      text: cancelNotice({ id, title: row.title }, by),
      receivedAt: now,
    });
  }
  return { cancelled: { id }, woken };
}

/**
 * Adds a note to the log of Assignment `id`, in `tx`, as the Bot it's handed to; the row keeps the
 * status it has. Only that Bot may, and not once the Assignment has ended. `woken` is the Conversation
 * to hint once `tx` has committed.
 */
export async function addAssignmentNote(
  deps: BotSdkContext,
  tx: Transaction,
  turn: AssignmentCaller,
  { id, note }: { id: string; note: string },
): Promise<{ noted: { id: string }; woken: string } | { error: string }> {
  const [row] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(and(eq(botAssignment.id, id), eq(botAssignment.assignedBotId, turn.botId)));
  if (!row) return { error: `No Assignment with id "${id}" is assigned to you.` };
  await lockConversation(tx, row.conversationId);
  const now = deps.clock();
  const [updated] = await tx
    .update(botAssignment)
    .set({ updatedAt: now })
    .where(and(eq(botAssignment.id, id), notInArray(botAssignment.status, endedStatuses)))
    .returning({ status: botAssignment.status });
  if (!updated) {
    // Read again: a cancel may have committed since `row` was read.
    const [now] = await tx
      .select({ status: botAssignment.status })
      .from(botAssignment)
      .where(eq(botAssignment.id, id));
    return {
      error:
        now?.status === "cancelled"
          ? `Assignment ${id} was cancelled, so it takes no more notes.`
          : `Assignment ${id} already ended.`,
    };
  }
  await logStatus(tx, {
    assignmentId: id,
    status: updated.status,
    actor: "bot",
    actorBotId: turn.botId,
    note,
    turnId: turn.id,
    at: now,
  });
  await recordBotChange(tx, { conversationId: row.conversationId }, "assignment", id, now);
  return { noted: { id }, woken: row.conversationId };
}

/** The most Assignments `readAssignments` lists, the newest. */
const readListLimit = 50;

/**
 * What Bot `botId` reads of the Assignments it is part of, as the assigned Bot or the assigner: with
 * an `id`, that one with its instructions, result and log; without, the newest few as a list. Any
 * other Assignment reads as if it didn't exist.
 */
export async function readAssignments(
  db: Database | Transaction,
  botId: string,
  id?: string,
): Promise<unknown> {
  const rows = await db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      status: botAssignment.status,
      result: botAssignment.result,
      assignedBotId: botAssignment.assignedBotId,
      assignedName: bot.name,
      assignerBotId: botAssignment.assignerBotId,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(
      and(
        or(eq(botAssignment.assignedBotId, botId), eq(botAssignment.assignerBotId, botId)),
        id ? eq(botAssignment.id, id) : undefined,
      ),
    )
    .orderBy(desc(botAssignment.createdAt), desc(botAssignment.id))
    .limit(id ? 1 : readListLimit);
  const assignerIds = rows.flatMap((row) => (row.assignerBotId ? [row.assignerBotId] : []));
  const assigners = assignerIds.length
    ? await db.select({ id: bot.id, name: bot.name }).from(bot).where(inArray(bot.id, assignerIds))
    : [];
  const summary = (row: (typeof rows)[number]) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    yourPart: row.assignedBotId === botId ? "assigned to you" : "started by you",
    assignedTo: row.assignedName,
    startedBy: assigners.find((assigner) => assigner.id === row.assignerBotId)?.name ?? null,
  });
  if (!id) return { assignments: rows.reverse().map(summary) };
  const [row] = rows;
  if (!row) return { error: `You're not part of an Assignment with id "${id}".` };
  const log = (await logsOf(db, [row.id])).get(row.id) ?? [];
  return {
    ...summary(row),
    instructions: row.instructions,
    result: row.result,
    log: log.map((entry) => ({
      at: entry.at.toISOString(),
      status: entry.status,
      by:
        entry.actor === "user"
          ? "the user"
          : entry.actor === "system"
            ? "the SDK"
            : (entry.actorName ?? "a Bot that's gone"),
      ...(entry.note && { note: entry.note }),
    })),
  };
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
