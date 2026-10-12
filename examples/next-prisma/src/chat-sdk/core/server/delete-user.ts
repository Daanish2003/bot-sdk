import { eq, inArray } from "drizzle-orm";

import { stopUserRuns } from "./chat/run";
import { attachment, attachmentBlob } from "./db/schema/attachment";
import { conversation, project } from "./db/schema/chat";
import { mcpConnection } from "./db/schema/connection";
import { userCredentials } from "./db/schema/credentials";
import { userSettings } from "./db/schema/settings";
import { usage } from "./db/schema/usage";
import type { AppDeps } from "./deps";

/**
 * Deletes everything the SDK holds for a user, in one transaction (spec #70). The Host calls it
 * when it deletes the user, and calling it again, or for an unknown id, does nothing.
 *
 * Order matters: Runs stop first so their owners write nothing more; Conversations go before
 * Attachments, because a Message's link to an Attachment does not cascade.
 */
export async function deleteUserData(deps: AppDeps, userId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    // 1. Stop the user's live Runs through the Stop path. The Run's owner aborts and, its row gone,
    // its later writes match nothing.
    await stopUserRuns(deps, userId, tx);

    // 2. Conversations, which cascade to their Messages, Shared links and Message–Attachment links.
    await tx.delete(conversation).where(eq(conversation.userId, userId));

    // 2b. Projects, after their Conversations; a Project's own Conversations are already gone.
    await tx.delete(project).where(eq(project.userId, userId));

    // 3. Attachments and their bytes. The bytes live in Postgres, so they go with their rows. There
    // is no external blob store yet: an external one would delete its objects here, best-effort,
    // after the commit.
    const ownAttachments = tx
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.userId, userId));
    await tx.delete(attachmentBlob).where(inArray(attachmentBlob.attachmentId, ownAttachments));
    await tx.delete(attachment).where(eq(attachment.userId, userId));

    // 4. Credentials and settings.
    await tx.delete(userCredentials).where(eq(userCredentials.userId, userId));
    await tx.delete(mcpConnection).where(eq(mcpConnection.userId, userId));
    await tx.delete(userSettings).where(eq(userSettings.userId, userId));
    // 5. Usage rows, which no Conversation cascades to: a deleted account keeps no Quota history.
    await tx.delete(usage).where(eq(usage.userId, userId));
  });
}

/**
 * Deletes every Conversation the user owns, Project ones included, in one transaction. Their
 * Messages, Shared links and Message–Attachment links go with them. The Projects stay, empty, and
 * so do the Attachments, which a Conversation's delete never removed (the reaper takes unused ones).
 * Live Runs in them stop first, as in `deleteUserData`.
 */
export async function deleteAllConversations(deps: AppDeps, userId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await stopUserRuns(deps, userId, tx);
    await tx.delete(conversation).where(eq(conversation.userId, userId));
  });
}
