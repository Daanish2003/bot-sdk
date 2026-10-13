import { conversation, message, project } from "../db/schema/chat";
import { generatedImage } from "../db/schema/generated-image";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { deleteBlobsBestEffort } from "../blob/store";
import { generatedImageKeysWhere, imagesOfMessages } from "../chat/generated-image-store";
import { stopProjectRuns } from "../chat/run";
import type { AppDeps } from "../deps";

type Deps = Pick<AppDeps, "db">;

/** How many Projects one user may have. */
export const projectLimit = 100;

/** The user's Project, or `undefined` when it doesn't exist or belongs to someone else. */
export async function findProject(deps: Deps, userId: string, id: string) {
  const [row] = await deps.db
    .select()
    .from(project)
    .where(and(eq(project.id, id), eq(project.userId, userId)));
  return row;
}

/** The Project's Instructions, or `null` when it has none or `projectId` is `null` (no Project). */
export async function projectInstructionsOf(deps: Deps, projectId: string | null) {
  if (!projectId) return null;
  const [row] = await deps.db
    .select({ instructions: project.instructions })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.instructions ?? null;
}

/** How many Projects the user has. */
export async function countProjects(deps: Deps, userId: string) {
  const [row] = await deps.db
    .select({ total: count() })
    .from(project)
    .where(eq(project.userId, userId));
  return row?.total ?? 0;
}

/**
 * The user's Projects, newest activity first. A Project's activity is the later of its creation
 * and its newest Conversation's last Message.
 */
export async function listProjects(deps: Deps, userId: string) {
  const activity = sql`greatest(${project.createdAt}, (select max(${conversation.lastMessageAt}) from ${conversation} where ${conversation.projectId} = ${project.id}))`;
  return deps.db
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(eq(project.userId, userId))
    .orderBy(desc(activity), desc(project.id));
}

/**
 * How many Conversations the user's Project holds, or `undefined` when the Project doesn't exist
 * or belongs to someone else.
 */
export async function countProjectConversations(deps: Deps, userId: string, id: string) {
  if (!(await findProject(deps, userId, id))) return undefined;
  const [row] = await deps.db
    .select({ total: count() })
    .from(conversation)
    .where(eq(conversation.projectId, id));
  return row?.total ?? 0;
}

/**
 * Deletes the user's Project and, by cascade, its Conversations with their Messages, Shared links
 * and Message–Attachment links. Live Runs in those Conversations stop first, as in `deleteUser`.
 * Answers how many Conversations went, or `undefined` when the Project doesn't exist or belongs to
 * someone else.
 */
export async function deleteProject(deps: AppDeps, userId: string, id: string) {
  const result = await deps.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.id, id), eq(project.userId, userId)))
      // Locks the Project row: a Conversation inserted into it waits for this commit (its foreign
      // key takes a shared lock), so the count below and the cascade see the same rows.
      .for("update");
    if (!owned) return undefined;
    const ended = await stopProjectRuns(deps, id, tx);
    const gone = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.projectId, id));
    // The Generated images of the Project's Conversations: their rows go by cascade, their bytes after the commit.
    const blobKeys = await generatedImageKeysWhere(
      tx,
      and(
        eq(generatedImage.userId, userId),
        imagesOfMessages(
          tx,
          inArray(
            message.conversationId,
            tx
              .select({ id: conversation.id })
              .from(conversation)
              .where(eq(conversation.projectId, id)),
          ),
        ),
      ),
    );
    await tx.delete(project).where(eq(project.id, id));
    return { gone, ended, blobKeys };
  });
  if (!result) return undefined;
  await deleteBlobsBestEffort(deps, result.blobKeys);
  // After the commit: a rolled-back delete fires nothing (#265, #266).
  for (const run of result.ended) deps.hooks.fire("onRunEnd", run);
  for (const row of result.gone) {
    deps.hooks.fire("onConversationDeleted", { userId, conversationId: row.id, projectId: id });
  }
  return result.gone.length;
}
