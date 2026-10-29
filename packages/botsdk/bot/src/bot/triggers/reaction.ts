import { and, eq } from "drizzle-orm";

import { message } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { lockConversation } from "./router";
import { findBot, setReaction, hintChanged, noResetAfter, recordBotChange } from "../conversation";

/**
 * Puts the user's emoji on Message `messageId` of a Bot's reply, or takes it off when `emoji` is
 * null (spec #761). Each Message holds at most one reaction from the user, so a second replaces the
 * first. It is a state change only: it records a `message` change and hints the other tabs, queues
 * no Trigger and so wakes no Turn. The Bot reads it in the input of its next Turn. Another user's
 * Bot, or a Message that isn't a Bot reply, is not found.
 */
export async function reactToMessage(
  sdk: BotSdkContext,
  userId: string,
  { botId, messageId, emoji }: { botId: string; messageId: string; emoji: string | null },
): Promise<void> {
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const now = sdk.clock();
  await sdk.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const [row] = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.id, messageId),
          eq(message.conversationId, found.conversationId),
          eq(message.role, "assistant"),
          // A Message from before the Bot's reset mark is one it no longer knows (spec #1007).
          noResetAfter(tx, { conversationId: found.conversationId }, message.createdAt),
        ),
      );
    if (!row) throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
    await setReaction(tx, messageId, "user", emoji, now);
    await recordBotChange(tx, found, "message", messageId, now);
  });
  await hintChanged(sdk, found.conversationId);
}
