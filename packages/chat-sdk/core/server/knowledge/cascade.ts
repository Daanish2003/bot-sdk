import type { SQL } from "drizzle-orm";

import { knowledgeBlobKey, deleteBlobsBestEffort } from "../blob/store";
import { knowledgeFile } from "../db/schema/knowledge";
import type { AppDeps } from "../deps";
import { knowledgeJobKey } from "./process";

/**
 * The ids of the Knowledge files `where` matches. A delete's cascade removes their rows and leaves
 * no record of them, so they are read first, inside the delete's transaction (as Generated images
 * are, ADR 0015).
 */
export async function knowledgeFileIdsWhere(
  db: Pick<AppDeps["db"], "select">,
  where: SQL | undefined,
): Promise<string[]> {
  const rows = await db.select({ id: knowledgeFile.id }).from(knowledgeFile).where(where);
  return rows.map((row) => row.id);
}

/**
 * After a delete's commit: cancels the processing jobs of these files, then deletes their original
 * bytes (best-effort). Same order as `deleteKnowledgeFile`.
 */
export async function discardKnowledgeFiles(deps: AppDeps, fileIds: string[]): Promise<void> {
  for (const fileId of fileIds) await deps.jobs.cancel(knowledgeJobKey(fileId));
  await deleteBlobsBestEffort(deps, fileIds.map(knowledgeBlobKey));
}
