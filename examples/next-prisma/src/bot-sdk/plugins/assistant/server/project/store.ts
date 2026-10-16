import { conversation, project, knowledgeFile } from "../../../../core/server/db/schema";
import { and, count, desc, eq, sql } from "drizzle-orm";

import { deleteConversations } from "../../../../core/server/chat/delete-conversations";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { discardKnowledgeFiles, knowledgeFileIdsWhere } from "../knowledge/cascade";

type Deps = Pick<BotSdkContext, "db">;

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
 * Deletes the user's Project with its Conversations, through the core's Conversation delete first
 * (their live Runs stop, through the delete hooks), then the Project. Answers how many
 * Conversations went, or `undefined` when the Project doesn't exist or belongs to someone else.
 */
export async function deleteProject(deps: BotSdkContext, userId: string, id: string) {
  const result = await deps.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.id, id), eq(project.userId, userId)))
      // Locks the Project row: a Conversation inserted into it waits for this commit (its foreign
      // key takes a shared lock), so the delete below sees every row and the cascade finds none left.
      .for("update");
    if (!owned) return undefined;
    // The Project's Conversations go through the core's delete; the cascade is only a safety net.
    const { deleted, afterCommit } = await deleteConversations(deps, tx, {
      where: eq(conversation.projectId, id),
      userId,
      announce: { projectId: conversation.projectId },
    });
    // The Knowledge files: their rows and passages go by cascade, their bytes and jobs after the commit.
    const knowledgeIds = await knowledgeFileIdsWhere(tx, eq(knowledgeFile.projectId, id));
    await tx.delete(project).where(eq(project.id, id));
    return { deleted, afterCommit, knowledgeIds };
  });
  if (!result) return undefined;
  // After the commit: a rolled-back delete fires nothing (#265, #266).
  await result.afterCommit();
  await discardKnowledgeFiles(deps, result.knowledgeIds);
  return result.deleted.length;
}
