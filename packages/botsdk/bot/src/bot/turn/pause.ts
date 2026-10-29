import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";

import { appendMessage } from "../../chat/message-tree";
import { bot, botTrigger, botTurn, deleteBlobsBestEffort } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { findBot, hintChanged, recordBotChange } from "../conversation";
import { deleteBotHelpers, stopHelpers } from "../helpers";
import { deleteBotCheckIns, deleteBotRoutines } from "../routines";
import { declineBotApprovals } from "../safety";
import { awaySummaryKey, lockConversation, skipWaiting } from "../triggers";
import { cancelTurn, runningTurnOf } from "./turn";

/**
 * Pauses the user's Bot (Bot pause, spec #1007): under its Conversation's row lock, it marks the
 * Bot paused, skips every Trigger waiting in its Conversation queue with reason `paused`, stops its
 * running Turn the way Stop does and stops all its Helpers. Each Routine keeps its own state. From
 * then on the Router keeps each Trigger as skipped (`receive`), so nothing wakes the Bot until it
 * is resumed. Pausing a paused Bot changes nothing. Another user's Bot is not found.
 */
export async function pauseBot(deps: BotSdkContext, userId: string, botId: string): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const paused = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const now = deps.clock();
    const [row] = await tx
      .update(bot)
      .set({ pausedAt: now })
      .where(and(eq(bot.id, botId), isNull(bot.pausedAt)))
      .returning({ id: bot.id });
    if (!row) return false;
    await haltBot(deps, tx, found, "paused", now);
    await recordBotChange(tx, found, "bot", botId, now);
    return true;
  });
  if (!paused) return;
  deps.runner.wake();
  await hintChanged(deps, found.conversationId);
}

/**
 * Resumes the user's paused Bot (spec #1007): only the pause is cleared. Nothing skipped meanwhile
 * is replayed, and its Routines run again from their next slot. Resuming a Bot that isn't paused
 * changes nothing. Another user's Bot is not found.
 */
export async function resumeBot(deps: BotSdkContext, userId: string, botId: string): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const resumed = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const [row] = await tx
      .update(bot)
      .set({ pausedAt: null })
      .where(and(eq(bot.id, botId), isNotNull(bot.pausedAt)))
      .returning({ id: bot.id });
    if (!row) return false;
    await recordBotChange(tx, found, "bot", botId, deps.clock());
    return true;
  });
  if (resumed) await hintChanged(deps, found.conversationId);
}

/**
 * Stops everything Bot `found` is doing (spec #1007), in `tx`, which holds its Conversation's row
 * lock: every Trigger waiting in its Conversation queue is skipped with `reason`, its running Turn
 * stops the way Stop stops it, and all its Helpers stop. Call the runner's `wake()` once `tx` has
 * committed.
 */
async function haltBot(
  deps: BotSdkContext,
  tx: Transaction,
  found: { id: string; conversationId: string },
  reason: "paused" | "reset",
  now: Date,
): Promise<void> {
  // Skipped before the Stop, so the Turn it ends finds the line empty and none follows it.
  await skipWaiting(tx, found.conversationId, reason, now);
  const running = await runningTurnOf(tx, found.id);
  if (running && (await cancelTurn(deps, tx, running, "stop"))) {
    // A Turn stopped before it took its input leaves its Triggers new; they are discarded, as if
    // they had still waited. A skipped Trigger has no Turn.
    await tx
      .update(botTrigger)
      .set({ turnId: null, skippedAt: now, skipReason: reason })
      .where(
        and(
          eq(botTrigger.turnId, running),
          notExists(
            tx
              .select({ id: botTurn.id })
              .from(botTurn)
              .where(
                and(
                  eq(botTurn.id, running),
                  or(isNotNull(botTurn.input), sql`jsonb_array_length(${botTurn.transcript}) > 0`),
                ),
              ),
          ),
        ),
      );
  }
  await stopHelpers(deps, tx, found.id);
}

/**
 * Resets the user's Bot (Bot reset, spec #1007), once `name` is its name, in one transaction under
 * its Conversation's row lock, in order: it stops everything as a pause does, with skip reason
 * `reset`; declines its pending Approvals; deletes its Routines and Check-ins with their queued
 * fires; deletes its Helpers and their transcripts; and appends the reset mark, from which its
 * Turns' history and Prompt start begin. It keeps its pause state, Messages and Turns. Once that
 * commits, the Helpers' screenshots are deleted and each enabled feature forgets the Bot
 * (`resetBot`: Memory deletes its files). A reset can't be undone. A wrong name is refused;
 * another user's Bot is not found.
 */
export async function resetBot(
  deps: BotSdkContext,
  userId: string,
  { botId, name }: { botId: string; name: string },
): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  if (name !== found.name) {
    throw rpcError("BAD_REQUEST", "error.botResetName", "The name doesn't match the Bot's");
  }
  const screenshots = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const now = deps.clock();
    const owner = { botId, conversationId: found.conversationId };
    await haltBot(deps, tx, found, "reset", now);
    // The Stop may queue an away Summary of what came before; none is written.
    await deps.runner.cancelIn(tx, awaySummaryKey(botId));
    await declineBotApprovals(deps, tx, owner, now);
    await deleteBotRoutines(deps, tx, owner, now);
    await deleteBotCheckIns(deps, tx, owner, now);
    const keys = await deleteBotHelpers(tx, owner, now);
    await appendMessage(tx, found.conversationId, {
      role: "reset",
      parts: { schemaVersion: 1, parts: [] },
      status: "complete",
      createdAt: now,
    });
    await recordBotChange(tx, found, "bot", botId, now);
    return keys;
  });
  deps.runner.wake();
  await deleteBlobsBestEffort(deps, screenshots);
  await hintChanged(deps, found.conversationId);
}
