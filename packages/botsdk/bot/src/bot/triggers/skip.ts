import { and, eq } from "drizzle-orm";

import { bot, botTrigger } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { hintChanged } from "../conversation";
import { lockConversation, recordSkipChange } from "./router";

/**
 * The user skips one Trigger waiting in their Bot's Conversation queue (spec #1007): it is marked
 * skipped with reason `cancelled`, so no Turn ever takes it and it never shows in the Conversation.
 * Only a Routine's run (scheduled or webhook) or a Check-in's fire can be skipped; a user's Message
 * or a Helper's report is refused, and so is a Trigger a Turn has taken. A Trigger already skipped
 * stays as it was. Another user's Trigger is not found.
 */
export async function skipTrigger(
  deps: BotSdkContext,
  userId: string,
  triggerId: string,
): Promise<void> {
  let changed: string | undefined;
  await deps.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ conversationId: bot.conversationId, botId: bot.id })
      .from(botTrigger)
      .innerJoin(bot, eq(bot.conversationId, botTrigger.conversationId))
      .where(and(eq(botTrigger.id, triggerId), eq(bot.userId, userId)));
    if (!owner) throw notFound();
    // The Conversation's lock first, as a Turn's take does, so a Turn cannot take it meanwhile.
    await lockConversation(tx, owner.conversationId);
    const [trigger] = await tx
      .select()
      .from(botTrigger)
      .where(eq(botTrigger.id, triggerId))
      .for("update");
    if (!trigger) throw notFound();
    if (trigger.source !== "routine" && trigger.source !== "check_in") {
      throw rpcError(
        "BAD_REQUEST",
        "error.triggerNotSkippable",
        "Only a Routine's run or a Check-in can be skipped",
      );
    }
    if (trigger.turnId) {
      throw rpcError("CONFLICT", "error.triggerTaken", "A Turn already took this");
    }
    if (trigger.skippedAt) return;
    const now = deps.clock();
    await tx
      .update(botTrigger)
      .set({ skippedAt: now, skipReason: "cancelled" })
      .where(eq(botTrigger.id, triggerId));
    // The Tasks view refreshes on its Routine and Check-in changes.
    await recordSkipChange(tx, owner, trigger, now);
    changed = owner.conversationId;
  });
  if (changed) await hintChanged(deps, changed);
}

const notFound = () => rpcError("NOT_FOUND", "error.triggerNotFound", "Trigger not found");
