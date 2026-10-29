import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { bot } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { findBot, hintChanged, recordBotChange } from "../conversation";
import { stopHelpers } from "../helpers";
import { lockConversation, skipWaiting } from "../triggers";
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
    // Skipped before the Stop, so the Turn it ends finds the line empty and none follows it.
    await skipWaiting(tx, found.conversationId, "paused", now);
    const running = await runningTurnOf(tx, botId);
    if (running) await cancelTurn(deps, tx, running, "stop");
    await stopHelpers(deps, tx, botId);
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
