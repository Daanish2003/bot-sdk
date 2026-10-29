import { and, eq, gt, notExists, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { bot, message } from "../../storage";
import type { Database } from "../../storage";
import type { Transaction } from "../../plugin";

/** A reset mark, aliased so a query on `message` can look for one. */
const mark = alias(message, "reset_mark");

/**
 * Whether no reset mark (Bot reset, spec #1007) came after `at` in the Bot's Conversation: that of
 * Bot `botId`, or Conversation `conversationId`. The Bot sees nothing from before its latest reset
 * mark, so a Turn, Prompt start or Message it is told of must pass this.
 */
export function noResetAfter(
  db: Database | Transaction,
  owner: { botId: SQLWrapper | string } | { conversationId: string },
  at: SQLWrapper,
): SQL {
  const after = and(eq(mark.role, "reset"), gt(mark.createdAt, at));
  return notExists(
    "botId" in owner
      ? db
          .select({ id: mark.id })
          .from(mark)
          .innerJoin(bot, eq(bot.conversationId, mark.conversationId))
          .where(and(eq(bot.id, owner.botId), after))
      : db
          .select({ id: mark.id })
          .from(mark)
          .where(and(eq(mark.conversationId, owner.conversationId), after)),
  );
}
