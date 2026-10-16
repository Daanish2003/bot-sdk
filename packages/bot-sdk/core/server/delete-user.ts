import { eq, inArray } from "drizzle-orm";

import { attachmentBlobKey, deleteBlobsBestEffort } from "./blob/store";
import { generatedImageKeysWhere } from "./chat/generated-image-store";
import { stopUserRuns } from "./chat/run";
import {
  attachment,
  blob,
  conversation,
  project,
  mcpConnection,
  userCredentials,
  generatedImage,
  savedPrompt,
  userSettings,
  usage,
  knowledgeFile,
} from "./db/schema";
import type { AppDeps } from "./deps";
import { discardKnowledgeFiles, knowledgeFileIdsWhere } from "./knowledge/cascade";
import { withProjectId } from "./chat/hooks";

/**
 * Deletes everything the SDK holds for a user, in one transaction (spec #70). The Host calls it
 * when it deletes the user, and calling it again, or for an unknown id, does nothing.
 *
 * Order matters: Runs stop first so their owners write nothing more; Conversations go before
 * Attachments, because a Message's link to an Attachment does not cascade.
 */
export async function deleteUserData(deps: AppDeps, userId: string): Promise<void> {
  const { blobKeys, knowledgeIds } = await deps.db.transaction(async (tx) => {
    // 1. Stop the user's live Runs through the Stop path. The Run's owner aborts and, its row gone,
    // its later writes match nothing. No `onRunEnd` fires for them: a Host's user delete emits nothing (#265).
    await stopUserRuns(deps, userId, tx);

    // 2. Generated images: their rows go by cascade with their Messages, so their keys are read first.
    const imageKeys = await generatedImageKeysWhere(tx, eq(generatedImage.userId, userId));

    // 3. Conversations, which cascade to their Messages, Shared links and Message–Attachment links.
    await tx.delete(conversation).where(eq(conversation.userId, userId));

    // 2a. Knowledge files: their rows and passages go with their Projects; their bytes and jobs go after the commit.
    const knowledgeIds = await knowledgeFileIdsWhere(tx, eq(knowledgeFile.userId, userId));

    // 2b. Projects, after their Conversations; a Project's own Conversations are already gone.
    await tx.delete(project).where(eq(project.userId, userId));

    // 3b. Attachments and their bytes. The keys are collected here and their bytes deleted after the
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
    return { blobKeys: [...keys, ...imageKeys], knowledgeIds };
  });
  // 6. The store's own bytes, after the commit and best-effort: a failure is logged, not thrown.
  await deleteBlobsBestEffort(deps, blobKeys);
  await discardKnowledgeFiles(deps, knowledgeIds);
}

/**
 * Deletes every Conversation the user owns, Project ones included, in one transaction. Their
 * Messages, Shared links and Message–Attachment links go with them. The Projects stay, empty, and
 * so do the Attachments, which a Conversation's delete never removed (the reaper takes unused ones).
 * Live Runs in them stop first, as in `deleteUserData`.
 */
export async function deleteAllConversations(deps: AppDeps, userId: string): Promise<void> {
  const { ended, gone, blobKeys } = await deps.db.transaction(async (tx) => {
    const ended = await stopUserRuns(deps, userId, tx);
    // The Generated images of these Conversations: their rows go by cascade, their bytes after the commit.
    const blobKeys = await generatedImageKeysWhere(tx, eq(generatedImage.userId, userId));
    const gone = await tx
      .delete(conversation)
      .where(eq(conversation.userId, userId))
      .returning({ id: conversation.id, projectId: conversation.projectId });
    return { ended, gone, blobKeys };
  });
  await deleteBlobsBestEffort(deps, blobKeys);
  // After the commit: a rolled-back delete fires nothing (#265, #266).
  for (const run of ended) deps.hooks.fire("onRunEnd", run);
  for (const row of gone) {
    deps.hooks.fire("onConversationDeleted", {
      userId,
      conversationId: row.id,
      ...withProjectId(row.projectId),
    });
  }
}
