import {
  answeredChoiceText,
  type ChoiceInput,
  maxChoiceOtherLength,
} from "@botsdk/client/bot/choice";
import { searchTextOf } from "@botsdk/client/message-parts";
import { and, eq, gt } from "drizzle-orm";

import { botRoomMember, message } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { rpcError } from "../../rpc-error";
import {
  hintBotThread,
  isPaused,
  lockTurnConversations,
  receive,
  type ReceivedTrigger,
} from "./router";
import {
  controlOf,
  controlParts,
  findBot,
  hintChanged,
  isRoomOf,
  noResetAfter,
  recordBotChange,
} from "../conversation";

/** The Trigger id of the answer to the choice on Message `messageId`: one answer, one Trigger. */
export const choiceTriggerId = (messageId: string) => `action:${messageId}`;

/**
 * Answers the choice on Message `messageId` of the user's Bot `botId`, on `channel` (spec #761). In
 * one transaction under the Conversation's row lock it fills the control's answered state, records
 * a `message` change and queues the Trigger `action:<messageId>` (source `user`), so the first
 * answer wins: a later one, from any app, is refused as answered. The Bot is woken even if it has
 * moved on since asking. Another user's Bot or a Message with no choice is not found. A choice
 * asked in one of the user's Rooms (spec #1055) is answered there, and wakes only the Bot that
 * wrote it, found from its author, whichever member `botId` names.
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
  const [asked] = await sdk.db
    .select({ conversationId: message.conversationId, authorBotId: message.authorBotId })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.role, "assistant")));
  const inRoom =
    asked !== undefined &&
    asked.conversationId !== found.conversationId &&
    (await isRoomOf(sdk.db, userId, asked.conversationId));
  if (inRoom && !asked.authorBotId) {
    throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
  }
  // Who is woken, and where: the Bot's 1:1 Conversation, or the Room and the Bot that wrote it.
  const owner = inRoom
    ? { botId: asked.authorBotId!, conversationId: asked.conversationId }
    : { botId, conversationId: found.conversationId };
  const free = "other" in answer ? answer.other.trim().slice(0, maxChoiceOtherLength) : undefined;
  const now = sdk.clock();
  const { started } = await sdk.db.transaction(async (tx) => {
    // With the Bot's 1:1 for a Room's choice, in id order: a Room Turn's start writes both.
    await lockTurnConversations(tx, owner);
    const [member] = inRoom
      ? await tx
          .select({ resetAt: botRoomMember.resetAt })
          .from(botRoomMember)
          .where(
            and(
              eq(botRoomMember.conversationId, owner.conversationId),
              eq(botRoomMember.botId, owner.botId),
            ),
          )
      : [];
    // A Bot that left the Room is gone from it: its question has no one to answer to.
    if (inRoom && !member) {
      throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
    }
    const [row] = await tx
      .select({ parts: message.parts })
      .from(message)
      .where(
        and(
          eq(message.id, messageId),
          eq(message.conversationId, owner.conversationId),
          eq(message.role, "assistant"),
          // A question from before the Bot's reset mark is one it no longer knows (spec #1007); in
          // a Room that is its member row's reset point.
          member
            ? member.resetAt
              ? gt(message.createdAt, member.resetAt)
              : undefined
            : noResetAfter(tx, { conversationId: owner.conversationId }, message.createdAt),
        ),
      );
    const choice = row && controlOf(row.parts, "choice");
    if (!row || !choice) throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
    if (choice.answer) {
      throw rpcError("CONFLICT", "error.choiceAnswered", "This question was already answered");
    }
    // A paused Bot hears nothing (spec #1007): the answer is refused, so the choice stays open.
    if (await isPaused(tx, owner.botId)) {
      throw rpcError("CONFLICT", "error.botPaused", "Bot is paused. Resume to send.");
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
    await recordBotChange(tx, owner, "message", messageId, now);
    return receive(sdk, tx, {
      id: choiceTriggerId(messageId),
      botId: owner.botId,
      conversationId: owner.conversationId,
      source: "user",
      channel,
      text: answeredChoiceText(question, text),
      receivedAt: now,
    });
  });
  sdk.runner.wake();
  await hintChanged(sdk, owner.conversationId);
  if (started) await hintBotThread(sdk, owner);
}
