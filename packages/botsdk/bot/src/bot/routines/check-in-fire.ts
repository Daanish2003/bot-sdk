import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { bot, botCheckIn, botTrigger } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { defineCoreJob } from "../../runner/internal";
import { checkInFireJobName, checkInKey, checkInNotice } from "./check-in";
import { hintChanged, recordBotChange } from "../conversation";
import { lockConversation, receive } from "../triggers";

/**
 * One Check-in's fire (#540), a single delayed job. Its Checkpoint hands the Router the Check-in's
 * Trigger and marks it `fired`, so both happen once.
 */
export const checkInFireJob = defineCoreJob({
  name: checkInFireJobName,
  payload: z.object({ checkInId: z.uuid() }),
  run: async ({ checkInId }, ctx) => {
    const deps = ctx.deps;
    const fired = await ctx.step("fire", (tx) => fireCheckIn(deps, tx, checkInId));
    if (!fired) return;
    if (fired.woke) deps.runner.wake();
    await hintChanged(deps, fired.conversationId);
  },
  // A fire that failed for good marked nothing (its Checkpoint rolled back): mark it `failed` here,
  // with no Trigger, so it never stays pending.
  onFailed: async ({ checkInId }, _error, { deps }) => {
    const failed = await deps.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ conversationId: bot.conversationId })
        .from(botCheckIn)
        .innerJoin(bot, eq(bot.id, botCheckIn.botId))
        .where(eq(botCheckIn.id, checkInId));
      if (!owner) return null;
      await lockConversation(tx, owner.conversationId);
      const now = deps.clock();
      const rows = await tx
        .update(botCheckIn)
        .set({ state: "failed", updatedAt: now })
        .where(and(eq(botCheckIn.id, checkInId), eq(botCheckIn.state, "pending")))
        .returning({ id: botCheckIn.id });
      if (rows.length === 0) return null;
      await recordBotChange(tx, owner, "check_in", checkInId, now);
      return owner;
    });
    if (failed) await hintChanged(deps, failed.conversationId);
  },
});

/**
 * Fires the Check-in while it is `pending`: hands the Router a `check_in` / `schedule` Trigger with
 * the Check-in's notice and marks it `fired`. While the user's Quota is spent no Trigger is handed
 * (there is no caller to show a 402 to), nor while the user is Banned (#585), and the Check-in is
 * `fired` all the same, so it never lingers as pending. Returns its Conversation, with whether a
 * Trigger woke it, or `null` when it was no longer pending.
 */
async function fireCheckIn(
  deps: BotSdkContext,
  tx: Transaction,
  checkInId: string,
): Promise<{ conversationId: string; woke: boolean } | null> {
  const [owner] = await tx
    .select({
      botId: bot.id,
      conversationId: bot.conversationId,
      userId: bot.userId,
      model: bot.model,
    })
    .from(botCheckIn)
    .innerJoin(bot, eq(bot.id, botCheckIn.botId))
    .where(eq(botCheckIn.id, checkInId));
  if (!owner) return null;
  // The Quota and the Ban are read before any lock is taken, so a slow read never holds up the
  // Conversation.
  const call = await deps.models.resolveModelCall(owner.userId, owner.model);
  const quotaSpent = call ? !(await call.meter.mayRun()).ok : false;
  const banned = await deps.isUserBlocked(owner.userId);
  await lockConversation(tx, owner.conversationId);
  const [row] = await tx
    .update(botCheckIn)
    .set({ state: "fired", updatedAt: deps.clock() })
    .where(and(eq(botCheckIn.id, checkInId), eq(botCheckIn.state, "pending")))
    .returning();
  if (!row) return null;
  await recordBotChange(tx, owner, "check_in", checkInId, row.updatedAt);
  const unwoken = { conversationId: owner.conversationId, woke: false };
  if (quotaSpent || banned) return unwoken;
  const id = checkInKey(checkInId);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(and(eq(botTrigger.id, id), eq(botTrigger.botId, owner.botId)));
  if (seen) return unwoken;
  await receive(deps, tx, {
    id,
    botId: owner.botId,
    conversationId: owner.conversationId,
    source: "check_in",
    channel: "schedule",
    text: await checkInNotice(tx, owner.conversationId, row),
    receivedAt: deps.clock(),
  });
  return { conversationId: owner.conversationId, woke: true };
}
