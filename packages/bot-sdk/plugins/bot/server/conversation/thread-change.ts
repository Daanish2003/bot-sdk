import type { BotChangeKind } from "@botsdk/client/bot/changes";
import { eq } from "drizzle-orm";

import { recordChange } from "../../../../core/server/chat/change-log";
import { conversationChannel } from "../../../../core/server/chat/conversation-events";
import { bot } from "../../../../core/server/storage";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";

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

/**
 * Tells whoever follows the Conversation that it changed, so they re-read it from Postgres. Never
 * throws: a lost hint is covered by a tab's fetch on focus, on reconnect and, while a Turn runs, every 30 s (ADR 0026).
 */
export async function hintChanged(deps: BotSdkContext, conversationId: string) {
  try {
    await deps.pubsub.publish(
      conversationChannel(conversationId),
      JSON.stringify({ type: "changed" }),
    );
  } catch (caught) {
    deps.logger.error(`Publishing a change of Conversation ${conversationId} failed`, caught);
  }
}
