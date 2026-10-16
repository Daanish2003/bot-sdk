import { and, eq, gte, inArray, lt, notExists, or } from "drizzle-orm";

import { deleteBlobsBestEffort } from "../blob/store";
import { attachment, messageAttachment, conversation, message } from "../db/schema";
import type { BotSdkContext } from "../plugin";
import { generatedImageKeysWhere, imagesOfMessages } from "./generated-image-store";

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
 * uses one. Takes `now` as an argument, as the reaper does.
 */
export async function sweepExpiredTemporaryConversations(
  deps: Pick<BotSdkContext, "db" | "blobStore" | "logger">,
  now = new Date(),
): Promise<void> {
  const blobKeys = await deps.db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(
        and(eq(conversation.temporary, true), lt(conversation.lastMessageAt, expiryCutoff(now))),
      );
    if (expired.length === 0) return [];
    const conversationIds = expired.map((row) => row.id);

    const linked = await tx
      .selectDistinct({ attachmentId: messageAttachment.attachmentId })
      .from(messageAttachment)
      .innerJoin(message, eq(message.id, messageAttachment.messageId))
      .where(inArray(message.conversationId, conversationIds));

    // The Generated images of these Conversations: their rows go by cascade, their bytes after the commit.
    const keys = await generatedImageKeysWhere(
      tx,
      imagesOfMessages(tx, inArray(message.conversationId, conversationIds)),
    );

    await tx.delete(conversation).where(inArray(conversation.id, conversationIds));

    const attachmentIds = linked.map((row) => row.attachmentId);
    if (attachmentIds.length > 0) {
      await tx
        .delete(attachment)
        .where(
          and(
            inArray(attachment.id, attachmentIds),
            notExists(
              tx
                .select({ id: messageAttachment.attachmentId })
                .from(messageAttachment)
                .where(eq(messageAttachment.attachmentId, attachment.id)),
            ),
          ),
        );
    }
    return keys;
  });
  await deleteBlobsBestEffort(deps, blobKeys);
}
