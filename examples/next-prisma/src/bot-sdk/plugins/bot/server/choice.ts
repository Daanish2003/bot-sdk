import { and, eq } from "drizzle-orm";

import { message } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { searchTextOf } from "../../../core/shared/message-parts";
import { answeredChoiceText, type ChoiceInput, maxChoiceOtherLength } from "../shared/choice";
import { lockConversation, receive, type ReceivedTrigger } from "./router";
import { controlOf, controlParts, findBot } from "./store";
import { recordBotChange } from "./thread-change";
import { hintChanged } from "./turn";

/** The Trigger id of the answer to the choice on Message `messageId`: one answer, one Trigger. */
export const choiceTriggerId = (messageId: string) => `action:${messageId}`;

/**
 * Answers the choice on Message `messageId` of the user's Bot `botId`, on `channel` (spec #761). In
 * one transaction under the Conversation's row lock it fills the control's answered state, records
 * a `message` change and queues the Trigger `action:<messageId>` (source `user`), so the first
 * answer wins: a later one, from any app, is refused as answered. The Bot is woken even if it has
 * moved on since asking. Another user's Bot or a Message with no choice is not found.
 */
export async function answerChoice(
  sdk: BotSdkContext,
  userId: string,
  {
    botId,
    messageId,
    answer,
    channel = "web",
  }: {
    botId: string;
    messageId: string;
    answer: ChoiceInput;
    channel?: ReceivedTrigger["channel"];
  },
): Promise<void> {
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const free = "other" in answer ? answer.other.trim().slice(0, maxChoiceOtherLength) : undefined;
  const now = sdk.clock();
  await sdk.db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const [row] = await tx
      .select({ parts: message.parts })
      .from(message)
      .where(
        and(
          eq(message.id, messageId),
          eq(message.conversationId, found.conversationId),
          eq(message.role, "assistant"),
        ),
      );
    const choice = row && controlOf(row.parts, "choice");
    if (!row || !choice) throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
    if (choice.answer) {
      throw rpcError("CONFLICT", "error.choiceAnswered", "This question was already answered");
    }
    const text = free ?? ("option" in answer ? answer.option : "");
    const valid = free !== undefined ? choice.other && free !== "" : choice.options.includes(text);
    if (!valid) throw rpcError("BAD_REQUEST", "error.choiceInvalid", "Not one of the options");
    const question = searchTextOf(row.parts);
    await tx
      .update(message)
      .set({
        parts: controlParts(
          question,
          { ...choice, answer: { text, other: free !== undefined } },
          row.parts,
        ),
      })
      .where(eq(message.id, messageId));
    await recordBotChange(tx, found, "message", messageId, now);
    await receive(sdk, tx, {
      id: choiceTriggerId(messageId),
      conversationId: found.conversationId,
      source: "user",
      channel,
      text: answeredChoiceText(question, text),
      receivedAt: now,
    });
  });
  sdk.plugin("runner").wake();
  await hintChanged(sdk, found.conversationId);
}
