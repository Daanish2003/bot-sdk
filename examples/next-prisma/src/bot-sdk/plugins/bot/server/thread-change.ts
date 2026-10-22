import { eq } from "drizzle-orm";

import { recordChange } from "../../../core/server/chat/change-log";
import { bot } from "../../../core/server/db/schema";
import type { Transaction } from "../../../core/server/plugin";
import type { BotChangeKind } from "../shared/changes";

/**
 * Records a change of `kind` to `refId` in the Bot thread's change log (ADR 0026), in `tx`, under
 * the Conversation's row lock: the Conversation is `conversationId`, or Bot `botId`'s. Take the
 * Conversation's row lock (`lockConversation`) before any other row the transaction locks.
 */
export async function recordBotChange(
  tx: Transaction,
  owner: { conversationId: string } | { botId: string },
  kind: BotChangeKind,
  refId: string,
  at: Date,
): Promise<void> {
  let conversationId: string | undefined;
  if ("conversationId" in owner) conversationId = owner.conversationId;
  else {
    const [row] = await tx
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, owner.botId));
    conversationId = row?.conversationId;
  }
  // A Bot deleted meanwhile has no thread to change.
  if (conversationId) await recordChange(tx, conversationId, { kind, refId, at });
}
