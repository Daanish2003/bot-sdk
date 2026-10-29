import { and, eq, max, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { bot, message } from "../../storage";
import type { Database } from "../../storage";
import type { Transaction } from "../../plugin";

/**
 * Whether no reset mark (Bot reset, spec #1007) came after `at` in the Bot's Conversation: that of
 * Bot `botId`, or Conversation `conversationId`. The Bot sees nothing from before its latest reset
 * mark, so a Turn, Prompt start or Message it is told of must pass this. The latest mark is read
 * once per query (an uncorrelated subquery), not once per row.
 */
export function noResetAfter(
  db: Database | Transaction,
  owner: { botId: string } | { conversationId: string },
  at: SQLWrapper,
): SQL {
  const isMark = eq(message.role, "reset");
  const latest =
    "botId" in owner
      ? db
          .select({ at: max(message.createdAt) })
          .from(message)
          .innerJoin(bot, eq(bot.conversationId, message.conversationId))
          .where(and(eq(bot.id, owner.botId), isMark))
      : db
          .select({ at: max(message.createdAt) })
          .from(message)
          .where(and(eq(message.conversationId, owner.conversationId), isMark));
  return sql`${at} >= coalesce((${latest}), '-infinity')`;
}
