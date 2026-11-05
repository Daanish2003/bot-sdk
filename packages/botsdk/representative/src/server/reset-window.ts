import { and, eq, max } from "drizzle-orm";

import type { Transaction } from "@botsdk/bot/plugin";
import { bot, message } from "@botsdk/bot/storage";

/** When the Bot was last reset: anything it asked before then, it has forgotten. */
export async function lastResetOf(tx: Transaction, botId: string) {
  const [mark] = await tx
    .select({ at: max(message.createdAt) })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(and(eq(bot.id, botId), eq(message.role, "reset")));
  return mark?.at ?? null;
}
