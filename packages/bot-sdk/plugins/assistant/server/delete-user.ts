import { eq, inArray } from "drizzle-orm";

import { attachmentBlobKey, deleteBlobsBestEffort } from "../../../core/server/blob/store";
import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import {
  attachment,
  blob,
  conversation,
  project,
  mcpConnection,
  userCredentials,
  savedPrompt,
  userSettings,
  usage,
  knowledgeFile,
} from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { discardKnowledgeFiles, knowledgeFileIdsWhere } from "./knowledge/cascade";

/**
 * Deletes everything the SDK holds for a user, in one transaction (spec #70). The Host calls it
 * when it deletes the user, and calling it again, or for an unknown id, does nothing.
 *
 * Order matters: Conversations go first, before their Projects and before Attachments, because a
 * Message's link to an Attachment does not cascade.
 */
export async function deleteUserData(deps: BotSdkContext, userId: string): Promise<void> {
  const { blobKeys, knowledgeIds, afterCommit } = await deps.db.transaction(async (tx) => {
    // 1. Conversations, through the delete hooks, which stop their live Runs and collect their
    // Generated images' keys; their Messages, Shared links and Message–Attachment links go by cascade.
    // Muted: a Host's user delete emits nothing, not even `onRunEnd` (#265).
    const { afterCommit } = await deleteConversations(deps, tx, { userId, mute: true });

    // 2. Knowledge files: their rows and passages go with their Projects; their bytes and jobs go after the commit.
    const knowledgeIds = await knowledgeFileIdsWhere(tx, eq(knowledgeFile.userId, userId));

    // 2b. Projects, after their Conversations; a Project's own Conversations are already gone.
    await tx.delete(project).where(eq(project.userId, userId));

    // 3. Attachments and their bytes. The keys are collected here and their bytes deleted after the
    // commit. The Postgres bytes also go in this transaction, so the default store stays atomic.
    const ownAttachments = await tx
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.userId, userId));
    const keys = ownAttachments.map((row) => attachmentBlobKey(row.id));
    if (keys.length > 0) await tx.delete(blob).where(inArray(blob.key, keys));
    await tx.delete(attachment).where(eq(attachment.userId, userId));

    // 4. Credentials and settings.
    await tx.delete(userCredentials).where(eq(userCredentials.userId, userId));
    await tx.delete(mcpConnection).where(eq(mcpConnection.userId, userId));
    await tx.delete(userSettings).where(eq(userSettings.userId, userId));
    await tx.delete(savedPrompt).where(eq(savedPrompt.userId, userId));
    // 5. Usage rows, which no Conversation cascades to: a deleted account keeps no Quota history.
    await tx.delete(usage).where(eq(usage.userId, userId));
    return { blobKeys: keys, knowledgeIds, afterCommit };
  });
  // 6. After the commit and best-effort: the delete hooks' work, then the store's own bytes.
  await afterCommit();
  await deleteBlobsBestEffort(deps, blobKeys);
  await discardKnowledgeFiles(deps, knowledgeIds);
}

/**
 * Deletes every Conversation the user owns, Project ones included, in one transaction. Their
 * Messages, Shared links and Message–Attachment links go with them. The Projects stay, empty, and
 * so do the Attachments, which a Conversation's delete never removed (the reaper takes unused ones).
 * Live Runs in them stop, through the delete hooks.
 */
export async function deleteAllConversations(deps: BotSdkContext, userId: string): Promise<void> {
  const { afterCommit } = await deps.db.transaction((tx) =>
    deleteConversations(deps, tx, { userId, announce: { projectId: conversation.projectId } }),
  );
  // After the commit: a rolled-back delete fires nothing (#265, #266).
  await afterCommit();
}
