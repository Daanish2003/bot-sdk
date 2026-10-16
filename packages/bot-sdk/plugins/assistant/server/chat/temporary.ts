import { and, eq, gte, inArray, lt, or } from "drizzle-orm";

import { deleteConversations } from "../../../../core/server/chat/delete-conversations";
import { deleteUnusedAttachments } from "../../../../core/server/attachments/store";
import { deleteBlobsBestEffort } from "../../../../core/server/blob/store";
import { messageAttachment, conversation, message } from "../../../../core/server/db/schema";
import type { BotSdkContext } from "../../../../core/server/plugin";

/** How long a Temporary Conversation lasts after its last Message (spec #262). */
const temporaryRetentionMs = 30 * 24 * 60 * 60_000;

/** A Temporary Conversation whose last Message is older than this is expired at `now`. */
const expiryCutoff = (now: Date) => new Date(now.getTime() - temporaryRetentionMs);

/**
 * Matches the Conversations that are live at `now`: every ordinary one, and a Temporary one whose
 * last Message is inside its 30 days. An expired Temporary Conversation is gone to every read.
 */
export const liveConversation = (now: Date) =>
  or(eq(conversation.temporary, false), gte(conversation.lastMessageAt, expiryCutoff(now)));

/**
 * Deletes the Temporary Conversations whose last Message is past their 30 days, in one
 * transaction. Their Messages go by cascade. Their Attachments go too, unless another Message still
 * uses one. Their live Runs stop, through the delete hooks. Takes `now` as an argument, as the
 * reaper does.
 */
export async function sweepExpiredTemporaryConversations(
  deps: BotSdkContext,
  now = new Date(),
): Promise<void> {
  const afterCommit = await deps.db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(
        and(eq(conversation.temporary, true), lt(conversation.lastMessageAt, expiryCutoff(now))),
      );
    if (expired.length === 0) return async () => {};
    const conversationIds = expired.map((row) => row.id);

    const linked = await tx
      .selectDistinct({ attachmentId: messageAttachment.attachmentId })
      .from(messageAttachment)
      .innerJoin(message, eq(message.id, messageAttachment.messageId))
      .where(inArray(message.conversationId, conversationIds));

    const deleted = await deleteConversations(deps, tx, {
      where: inArray(conversation.id, conversationIds),
      userId: null,
    });

    const blobKeys = await deleteUnusedAttachments(
      tx,
      linked.map((row) => row.attachmentId),
    );
    return async () => {
      await deleted.afterCommit();
      await deleteBlobsBestEffort(deps, blobKeys);
    };
  });
  await afterCommit();
}
