import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { bot, botCheckIn, botTrigger } from "../../../core/server/db/schema";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { defineJob } from "../../runner/server/jobs/define";
import { checkInFireJobName, checkInKey, checkInNotice } from "./check-in";
import { lockConversation, receive } from "./router";
import { hintChanged } from "./turn";

/**
 * One Check-in's fire (#540), a single delayed job. Its Checkpoint hands the Router the Check-in's
 * Trigger and marks it `fired`, so both happen once.
 */
export const checkInFireJob = defineJob({
  name: checkInFireJobName,
  payload: z.object({ checkInId: z.uuid() }),
  run: async ({ checkInId }, ctx) => {
    const deps = ctx.deps;
    const fired = await ctx.activity("fire", (tx) => fireCheckIn(deps, tx, checkInId));
    if (!fired) return;
    deps.plugin("runner").wake();
    await hintChanged(deps, fired.conversationId);
  },
  // A fire that failed for good marked nothing (its Checkpoint rolled back): mark it `failed` here,
  // with no Trigger, so it never stays pending.
  onFailed: async ({ checkInId }, _error, deps) => {
    await deps.db
      .update(botCheckIn)
      .set({ state: "failed", updatedAt: deps.clock() })
      .where(and(eq(botCheckIn.id, checkInId), eq(botCheckIn.state, "pending")));
  },
});

/**
 * Fires the Check-in while it is `pending`: hands the Router a `check_in` / `schedule` Trigger with
 * the Check-in's notice and marks it `fired`. While the user's Quota is spent no Trigger is handed
 * (there is no caller to show a 402 to), nor while the user is Banned (#585), and the Check-in is
 * `fired` all the same, so it never lingers as pending. Returns the Conversation that got a
 * Trigger, or `null`.
 */
async function fireCheckIn(
  deps: BotSdkContext,
  tx: Transaction,
  checkInId: string,
): Promise<{ conversationId: string } | null> {
  const [owner] = await tx
    .select({ conversationId: bot.conversationId, userId: bot.userId, model: bot.model })
    .from(botCheckIn)
    .innerJoin(bot, eq(bot.id, botCheckIn.botId))
    .where(eq(botCheckIn.id, checkInId));
  if (!owner) return null;
  // The Quota and the Ban are read before any lock is taken, so a slow read never holds up the
  // Conversation.
  const call = await deps.plugin("models").resolveModelCall(owner.userId, owner.model);
  const quotaSpent = call ? !(await call.meter.mayRun()).ok : false;
  const banned = await deps.isUserBlocked(owner.userId);
  await lockConversation(tx, owner.conversationId);
  const [row] = await tx
    .update(botCheckIn)
    .set({ state: "fired", updatedAt: deps.clock() })
    .where(and(eq(botCheckIn.id, checkInId), eq(botCheckIn.state, "pending")))
    .returning();
  if (!row || quotaSpent || banned) return null;
  const id = checkInKey(checkInId);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (seen) return null;
  await receive(deps, tx, {
    id,
    conversationId: owner.conversationId,
    source: "check_in",
    channel: "schedule",
    text: await checkInNotice(tx, owner.conversationId, row),
    receivedAt: deps.clock(),
  });
  return { conversationId: owner.conversationId };
}
