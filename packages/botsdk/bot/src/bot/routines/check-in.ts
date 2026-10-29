import type { BotCheckIn } from "@botsdk/client/bot/check-in";
import { and, asc, eq, sql } from "drizzle-orm";

import { bot, botCheckIn, botTurn } from "../../storage";
import type { Database } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { hintChanged, recordBotChange, newestTimeZone, knownZone } from "../conversation";
import { lockConversation } from "../triggers";
import { lastMessageOfTurn, zonedTime } from "./routine";

/** The runner job of one Check-in's fire (`check-in-fire.ts`). */
export const checkInFireJobName = "bot.check_in_fire";

/** The key of a Check-in's job, which is also the ID of the Trigger it hands the Router. */
export const checkInKey = (checkInId: string) => `check_in:${checkInId}`;

/** How far ahead a Check-in must be set. */
const minLeadMs = 60_000;

/** What `set_check_in` returns for an `at` that is too near. */
export const checkInTooSoonError =
  "Not saved: at must be at least a minute from now. Choose a later time.";

/**
 * Saves the Check-in a Turn's `set_check_in` call asked for (#540), with one delayed job that
 * fires it. No Approval. Returns the tool's result: saved, or an error the Model can act on.
 */
export async function saveCheckIn(
  deps: BotSdkContext,
  tx: Transaction,
  {
    botId,
    conversationId,
    turnId,
    at,
    note,
    now,
  }: { botId: string; conversationId: string; turnId: string; at: Date; note: string; now: Date },
): Promise<{ saved: { id: string; at: string } } | { error: string }> {
  if (at.getTime() - now.getTime() < minLeadMs) return { error: checkInTooSoonError };
  await lockConversation(tx, conversationId);
  const id = uuidv7();
  await tx.insert(botCheckIn).values({
    id,
    botId,
    at,
    note,
    state: "pending",
    createdByTurnId: turnId,
    createdAt: now,
    updatedAt: now,
  });
  await deps.runner.enqueueIn(
    tx,
    checkInFireJobName,
    { checkInId: id },
    { idempotencyKey: checkInKey(id), runAfter: at },
  );
  await recordBotChange(tx, { conversationId }, "check_in", id, now);
  return { saved: { id, at: at.toISOString() } };
}

/** The Bot's pending Check-ins, soonest first, for `list_check_ins`. */
export async function pendingCheckIns(db: Database | Transaction, botId: string) {
  const rows = await db
    .select({ id: botCheckIn.id, at: botCheckIn.at, note: botCheckIn.note })
    .from(botCheckIn)
    .where(and(eq(botCheckIn.botId, botId), eq(botCheckIn.state, "pending")))
    .orderBy(asc(botCheckIn.at), asc(botCheckIn.id));
  return rows.map((row) => ({ id: row.id, at: row.at.toISOString(), note: row.note }));
}

/**
 * Cancels the pending Check-in `checkInId` of the Bot, in `tx`, which holds its Conversation's row
 * lock: it never fires. `false` when the Bot has no pending Check-in by that id.
 */
async function cancelPending(
  deps: BotSdkContext,
  tx: Transaction,
  { botId, conversationId }: { botId: string; conversationId: string },
  checkInId: string,
): Promise<boolean> {
  const [row] = await tx
    .update(botCheckIn)
    .set({ state: "cancelled", updatedAt: deps.clock() })
    .where(
      and(
        eq(botCheckIn.id, checkInId),
        eq(botCheckIn.botId, botId),
        eq(botCheckIn.state, "pending"),
      ),
    )
    .returning({ id: botCheckIn.id });
  if (!row) return false;
  await recordBotChange(tx, { conversationId }, "check_in", checkInId, deps.clock());
  await deps.runner.cancelIn(tx, checkInKey(checkInId));
  return true;
}

/** Applies a Turn's `cancel_check_in` call (#540). Returns the tool's result. */
export async function cancelCheckInTool(
  deps: BotSdkContext,
  tx: Transaction,
  { botId, conversationId, id }: { botId: string; conversationId: string; id: string },
): Promise<{ cancelled: true } | { error: string }> {
  await lockConversation(tx, conversationId);
  if (await cancelPending(deps, tx, { botId, conversationId }, id)) return { cancelled: true };
  return { error: `No pending Check-in with id "${id}". list_check_ins shows yours.` };
}

/** The user's cancel of a Check-in of theirs, or `NOT_FOUND`. One no longer pending stays as it is. */
export async function cancelCheckIn(
  deps: BotSdkContext,
  userId: string,
  checkInId: string,
): Promise<void> {
  const cancelledIn = await deps.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ botId: bot.id, conversationId: bot.conversationId })
      .from(botCheckIn)
      .innerJoin(bot, eq(bot.id, botCheckIn.botId))
      .where(and(eq(botCheckIn.id, checkInId), eq(bot.userId, userId)));
    if (!owner) throw rpcError("NOT_FOUND", "error.checkInNotFound", "Check-in not found");
    // The Conversation's row lock first, as in a fire.
    await lockConversation(tx, owner.conversationId);
    return (await cancelPending(deps, tx, owner, checkInId)) ? owner.conversationId : null;
  });
  if (cancelledIn) await hintChanged(deps, cancelledIn);
}

/**
 * The user's edit of a Check-in of theirs: a new time re-queues its fire, and a new note is read
 * when it fires. `NOT_FOUND` for another user's; one that already fired, failed or was cancelled is
 * refused.
 */
export async function editCheckIn(
  deps: BotSdkContext,
  userId: string,
  { checkInId, at, note }: { checkInId: string; at?: Date; note?: string },
): Promise<void> {
  const now = deps.clock();
  if (at && at.getTime() - now.getTime() < minLeadMs) {
    throw rpcError("BAD_REQUEST", "error.checkInTooSoon", checkInTooSoonError);
  }
  const conversationId = await deps.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ conversationId: bot.conversationId })
      .from(botCheckIn)
      .innerJoin(bot, eq(bot.id, botCheckIn.botId))
      .where(and(eq(botCheckIn.id, checkInId), eq(bot.userId, userId)));
    if (!owner) throw rpcError("NOT_FOUND", "error.checkInNotFound", "Check-in not found");
    // The Conversation's row lock first, as in a fire.
    await lockConversation(tx, owner.conversationId);
    const [row] = await tx
      .update(botCheckIn)
      .set({ ...(at && { at }), ...(note !== undefined && { note }), updatedAt: now })
      .where(and(eq(botCheckIn.id, checkInId), eq(botCheckIn.state, "pending")))
      .returning({ botId: botCheckIn.botId });
    if (!row) {
      throw rpcError("CONFLICT", "error.checkInNotPending", "The Check-in is no longer pending");
    }
    await recordBotChange(tx, { botId: row.botId }, "check_in", checkInId, now);
    if (at) {
      await deps.runner.cancelIn(tx, checkInKey(checkInId));
      await deps.runner.enqueueIn(
        tx,
        checkInFireJobName,
        { checkInId },
        { idempotencyKey: checkInKey(checkInId), runAfter: at },
      );
    }
    return owner.conversationId;
  });
  await hintChanged(deps, conversationId);
}

/**
 * The Bot's Check-ins, soonest first, each with `afterMessageId`, the Message its inline line
 * follows (`lastMessageOfTurn`).
 */
export async function listCheckIns(db: Database, botId: string): Promise<BotCheckIn[]> {
  return db
    .select({
      id: botCheckIn.id,
      at: botCheckIn.at,
      note: botCheckIn.note,
      state: botCheckIn.state,
      createdAt: botCheckIn.createdAt,
      afterMessageId: sql<string | null>`(${lastMessageOfTurn(db)})`,
    })
    .from(botCheckIn)
    .innerJoin(bot, eq(bot.id, botCheckIn.botId))
    .innerJoin(botTurn, eq(botTurn.id, botCheckIn.createdByTurnId))
    .where(eq(botCheckIn.botId, botId))
    .orderBy(asc(botCheckIn.at), asc(botCheckIn.id));
}

/**
 * Deletes every Check-in of Bot `botId` (a Bot reset, spec #1007), in `tx`, which holds its
 * Conversation's row lock: a pending one's fire is cancelled, so it never fires.
 */
export async function deleteBotCheckIns(
  deps: BotSdkContext,
  tx: Transaction,
  owner: { botId: string; conversationId: string },
  at: Date,
): Promise<void> {
  const deleted = await tx
    .delete(botCheckIn)
    .where(eq(botCheckIn.botId, owner.botId))
    .returning({ id: botCheckIn.id, state: botCheckIn.state });
  for (const { id, state } of deleted) {
    await recordBotChange(tx, owner, "check_in", id, at);
    if (state === "pending") await deps.runner.cancelIn(tx, checkInKey(id));
  }
}

/** Cancels the queued jobs of the user's pending Check-ins, in `tx`, so none fires once they are deleted. */
export async function cancelUserCheckIns(
  deps: BotSdkContext,
  tx: Transaction,
  userId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: botCheckIn.id })
    .from(botCheckIn)
    .innerJoin(bot, eq(bot.id, botCheckIn.botId))
    .where(and(eq(bot.userId, userId), eq(botCheckIn.state, "pending")));
  const runner = deps.runner;
  for (const { id } of rows) await runner.cancelIn(tx, checkInKey(id));
}

/**
 * What a Check-in's fire gives the Model: the notice of what woke it, with the note its past self
 * left. Times read in the user's zone, so "set on" and "for" are on their clock.
 */
export async function checkInNotice(
  tx: Transaction,
  conversationId: string,
  row: { createdAt: Date; at: Date; note: string },
): Promise<string> {
  const zone = knownZone(await newestTimeZone(tx, conversationId));
  return (
    `Check-in you set on ${zonedTime(row.createdAt, zone)} for ${zonedTime(row.at, zone)} ` +
    `(${zone}): ${JSON.stringify(row.note)}. It's due now: do what the note says.`
  );
}
