import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../chat/message-tree";
import { bot, botTrigger, botTurn, deleteBlobsBestEffort } from "../../storage";
import { enabledFeatures } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import { defineCoreJob } from "../../runner/internal";
import { rpcError } from "../../rpc-error";
import { findBot, hintChanged, recordBotChange } from "../conversation";
import { deleteBotHelpers, stopHelpers } from "../helpers";
import { deleteBotCheckIns, deleteBotRoutines } from "../routines";
import { declineBotApprovals, reopenUnstartedCalls } from "../safety";
import { awaySummaryKey, lockConversation, runningTurnOf, skipWaiting } from "../triggers";
import { cancelTurn } from "./turn";

/**
 * Pauses the user's Bot (Bot pause, spec #1007): under its Conversation's row lock, it marks the
 * Bot paused, skips every Trigger waiting in its Conversation queue with reason `paused`, stops its
 * running Turn the way Stop does and stops all its Helpers. An allowed call that hasn't started is
 * cancelled, and its Approval is pending again. Each Routine keeps its own state. From then on the
 * Router keeps each Trigger as skipped (`receive`), so nothing wakes the Bot until it is resumed.
 * Pausing a paused Bot changes nothing. Another user's Bot is not found.
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
    // A yes whose call hasn't started is taken back: no work runs while paused.
    await reopenUnstartedCalls(deps, tx, { botId, conversationId: found.conversationId }, now);
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
 * A Turn stopped before it took its input leaves its Triggers new; they are discarded, as if they
 * had still waited, with skip reason `reason`. A skipped Trigger has no Turn. Call it after
 * `cancelTurn` ended Turn `turnId`.
 */
export async function discardUnstarted(
  tx: Transaction,
  turnId: string,
  reason: "cancelled" | "paused" | "reset",
  now: Date,
): Promise<void> {
  await tx
    .update(botTrigger)
    .set({ turnId: null, skippedAt: now, skipReason: reason })
    .where(
      and(
        eq(botTrigger.turnId, turnId),
        notExists(
          tx
            .select({ id: botTurn.id })
            .from(botTurn)
            .where(
              and(
                eq(botTurn.id, turnId),
                or(isNotNull(botTurn.input), sql`jsonb_array_length(${botTurn.transcript}) > 0`),
              ),
            ),
        ),
      ),
    );
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
  const owner = { botId: found.id, conversationId: found.conversationId };
  await skipWaiting(tx, owner, reason, now);
  const running = await runningTurnOf(tx, owner);
  if (running && (await cancelTurn(deps, tx, running, "stop"))) {
    await discardUnstarted(tx, running, reason, now);
  }
  await stopHelpers(deps, tx, found.id);
}

/**
 * Resets the user's Bot (Bot reset, spec #1007), once `name` is its name, in one transaction under
 * its Conversation's row lock, in order: it stops everything as a pause does, with skip reason
 * `reset`; declines its pending Approvals; deletes its Routines and Check-ins with their queued
 * fires; deletes its Helpers and their transcripts; and appends the reset mark, from which its
 * Turns' history and Prompt start begin. It keeps its pause state, Messages and Turns. Once that
 * commits, the Helpers' screenshots are deleted, best-effort, and each enabled feature forgets the
 * Bot (`resetBot`; Memory deletes its files) in `botResetJob`, queued in the same transaction. A
 * reset can't be undone. A wrong name is refused, checked against the Bot's row locked for update
 * so a rename can't race it; another user's Bot is not found.
 */
export async function resetBot(
  deps: BotSdkContext,
  userId: string,
  { botId, name }: { botId: string; name: string },
): Promise<void> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const screenshots = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const [current] = await tx
      .select({ name: bot.name })
      .from(bot)
      .where(eq(bot.id, botId))
      .for("update");
    if (name !== current?.name) {
      throw rpcError("BAD_REQUEST", "error.botResetName", "The name doesn't match the Bot's");
    }
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
    // Runs only once the reset stands, and again after a failure or a crash.
    await deps.runner.enqueueIn(tx, botResetJobName, { botId, userId });
    return keys;
  });
  deps.runner.wake();
  await deleteBlobsBestEffort(deps, screenshots);
  await hintChanged(deps, found.conversationId);
}

/** The runner job that has each enabled feature forget a reset Bot. */
export const botResetJobName = "bot.reset";

/**
 * What a Bot reset leaves to after its commit, enqueued in its transaction (`resetBot`): each
 * enabled feature's `resetBot`, once per feature (a recorded step), so a failure is retried with the
 * runner's backoff without repeating the features that are done. A job that fails for good is
 * logged; the reset stands.
 */
export const botResetJob = defineCoreJob({
  name: botResetJobName,
  payload: z.object({ botId: z.uuid(), userId: z.string() }),
  run: async ({ botId, userId }, ctx) => {
    for (const { feature, context } of enabledFeatures(ctx.deps)) {
      const forget = feature.resetBot;
      if (!forget) continue;
      await ctx.step(`forget:${feature.id}`, async () => {
        await forget(botId, userId, context);
        return null;
      });
    }
  },
  onFailed: ({ botId }, error, { deps }) => {
    deps.logger.error(`Features failed to forget Bot ${botId} on its reset`, error);
  },
});
