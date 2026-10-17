import { and, eq, isNull } from "drizzle-orm";

import { bot, botTrigger, botTurn, conversation } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";

/** The runner job that runs one Turn (`botTurnJob` in `turn.ts`). */
export const botTurnJobName = "bot.turn";

/** A Trigger as the Router receives it: its row, before any Turn has taken it. */
export type ReceivedTrigger = Omit<typeof botTrigger.$inferInsert, "turnId">;

/**
 * Takes the Conversation's row lock. Every transaction that starts or ends a Turn takes it first,
 * so a Conversation runs one Turn at a time (#499); the running-Turn index backs it up.
 */
export async function lockConversation(tx: Transaction, conversationId: string): Promise<void> {
  await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .for("update");
}

/**
 * The Router's way in (#499): queues the Trigger in its Conversation queue and, when no Turn is
 * running, starts one that takes it. Returns that Turn's id, or `undefined` when the Trigger waits
 * for the Turn that follows the running one. Call the runner's `wake()` once `tx` has committed.
 */
export async function receive(
  deps: BotSdkContext,
  tx: Transaction,
  trigger: ReceivedTrigger,
): Promise<string | undefined> {
  await lockConversation(tx, trigger.conversationId);
  await tx.insert(botTrigger).values(trigger);
  const [running] = await tx
    .select({ id: botTurn.id })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(and(eq(bot.conversationId, trigger.conversationId), eq(botTurn.status, "running")))
    .limit(1);
  if (running) return undefined;
  return startTurn(deps, tx, trigger.conversationId);
}

/**
 * Chains the next Turn (#499), in the transaction that ended `turnId`: if Triggers wait in its
 * Conversation queue, a new Turn takes all of them. Returns that Turn's id, or `undefined` when the
 * queue is empty. Call the runner's `wake()` once `tx` has committed.
 */
export async function turnEnded(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
): Promise<string | undefined> {
  const [ended] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  if (!ended) return undefined;
  await lockConversation(tx, ended.conversationId);
  return startTurn(deps, tx, ended.conversationId);
}

/** Creates a Turn that takes every Trigger waiting in the Conversation queue, and queues its job. */
async function startTurn(
  deps: BotSdkContext,
  tx: Transaction,
  conversationId: string,
): Promise<string | undefined> {
  const waiting = and(eq(botTrigger.conversationId, conversationId), isNull(botTrigger.turnId));
  const [first] = await tx.select({ id: botTrigger.id }).from(botTrigger).where(waiting).limit(1);
  if (!first) return undefined;
  const [owner] = await tx
    .select({ id: bot.id })
    .from(bot)
    .where(eq(bot.conversationId, conversationId));
  if (!owner) throw new Error(`Conversation ${conversationId} has no Bot`);
  const turnId = uuidv7();
  const jobId = await deps
    .plugin("runner")
    .enqueueIn(tx, botTurnJobName, { turnId }, { idempotencyKey: turnId });
  // A ms after now, so the Turn's input holds every Message saved before it, its Triggers' among them.
  await tx.insert(botTurn).values({
    id: turnId,
    botId: owner.id,
    status: "running",
    startedAt: new Date(deps.clock().getTime() + 1),
    jobId,
  });
  await tx.update(botTrigger).set({ turnId }).where(waiting);
  return turnId;
}
