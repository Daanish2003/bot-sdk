import { and, eq, inArray, isNull } from "drizzle-orm";

import type { BotSdkContext, Transaction } from "../../plugin";
import { botTrigger } from "../../storage";
import { noResetAfter } from "../conversation";
import { runningTurnOf, startTurn } from "../triggers";

/**
 * Delivers every answer Bot `botId` was given while paused (a denied Approval, a stored call's result
 * or a Custom Rule's answer), in the transaction that resumes it, which holds the locks of
 * `conversationIds`, its 1:1 and its Rooms: the Router kept each as skipped, and each was promised
 * to the Bot. Each wakes it in the Conversation it was asked in. One from before the Bot's last reset
 * stays skipped, as it has forgotten what was asked, and so does one from a Room it has left. Whether
 * it delivered any: if so, the caller wakes the runner once `tx` commits.
 */
export async function deliverAnswersAfterPause(
  deps: BotSdkContext,
  tx: Transaction,
  botId: string,
  conversationIds: string[],
): Promise<boolean> {
  const delivered = await tx
    .update(botTrigger)
    .set({ skippedAt: null, skipReason: null, receivedAt: deps.clock() })
    .where(
      and(
        eq(botTrigger.botId, botId),
        inArray(botTrigger.conversationId, conversationIds),
        eq(botTrigger.source, "approval"),
        eq(botTrigger.skipReason, "paused"),
        isNull(botTrigger.turnId),
        noResetAfter(tx, { botId }, botTrigger.receivedAt),
      ),
    )
    .returning({ conversationId: botTrigger.conversationId });
  for (const conversationId of new Set(delivered.map((row) => row.conversationId))) {
    const owner = { botId, conversationId };
    if (!(await runningTurnOf(tx, owner))) await startTurn(deps, tx, owner);
  }
  return delivered.length > 0;
}
