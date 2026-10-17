import { and, count, desc, eq } from "drizzle-orm";

import { deleteBlobsBestEffort } from "../../../../core/server/blob/store";
import { knowledgeBlobKey } from "../blob-keys";
import { project, knowledgeChunk, knowledgeFile } from "../../../../core/server/db/schema";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { findProject } from "../project/store";
import { rpcError } from "../../../../core/server/rpc-error";
import {
  knowledgeFilesPerProject,
  type KnowledgeFailureCode,
  type KnowledgeMediaType,
} from "../../shared/knowledge/kinds";
// Imported for its side effect: the job must be defined before the first upload enqueues it.
import { knowledgeJobKey, knowledgeProcessJob } from "./process";

/** What the Knowledge tab shows of a file. The bytes are never part of it. */
export type KnowledgeFileInfo = {
  id: string;
  name: string;
  mediaType: KnowledgeMediaType;
  size: number;
  status: "processing" | "ready" | "failed";
  failureCode: KnowledgeFailureCode | null;
  chunkCount: number | null;
  createdAt: Date;
};

/** How many Knowledge files the Project holds. */
async function countFiles(db: Pick<BotSdkContext["db"], "select">, projectId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(knowledgeFile)
    .where(eq(knowledgeFile.projectId, projectId));
  return row?.total ?? 0;
}

const infoColumns = {
  id: knowledgeFile.id,
  name: knowledgeFile.name,
  mediaType: knowledgeFile.mediaType,
  size: knowledgeFile.size,
  status: knowledgeFile.status,
  failureCode: knowledgeFile.failureCode,
  chunkCount: knowledgeFile.chunkCount,
  createdAt: knowledgeFile.createdAt,
};

/**
 * A Project's Knowledge: its embedding Model (the stored one, or the resolver's default before the
 * first upload), the embedding Models the user can use now, and its files. `undefined` when the
 * Project isn't the user's.
 */
export async function knowledgeOf(deps: BotSdkContext, userId: string, projectId: string) {
  const row = await findProject(deps, userId, projectId);
  if (!row) return undefined;
  const files: KnowledgeFileInfo[] = await deps.db
    .select(infoColumns)
    .from(knowledgeFile)
    .where(eq(knowledgeFile.projectId, projectId))
    .orderBy(desc(knowledgeFile.createdAt), desc(knowledgeFile.id));
  const models: string[] = [];
  for (const id of deps.plugin("models").embeddingModelIds()) {
    if (await deps.plugin("models").resolveEmbeddingModel(userId, id)) models.push(id);
  }
  const current = row.embeddingModel
    ? await deps.plugin("models").resolveEmbeddingModel(userId, row.embeddingModel)
    : await deps.plugin("models").defaultEmbeddingModel(userId);
  return {
    /** The stored Model, or null before the first upload. */
    embeddingModel: row.embeddingModel,
    /** The Model files are read and searched with now: the stored one, else the default. Null when the user can't use it. */
    currentModel: current ? { id: current.id, onHostCredentials: current.meter.onHost } : null,
    models,
    files,
  };
}

/**
 * Adds a Knowledge file to the user's Project and queues its processing. The bytes go to the blob
 * store first, then the row and the Project's Model (set on its first upload) in one transaction
 * that also checks the file limit; the job is queued after the commit, so it finds the row.
 */
export async function uploadKnowledgeFile(
  deps: BotSdkContext,
  userId: string,
  projectId: string,
  file: { name: string; mediaType: KnowledgeMediaType; bytes: Uint8Array },
): Promise<KnowledgeFileInfo> {
  const row = await findProject(deps, userId, projectId);
  if (!row) throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
  const model = row.embeddingModel
    ? await deps.plugin("models").resolveEmbeddingModel(userId, row.embeddingModel)
    : await deps.plugin("models").defaultEmbeddingModel(userId);
  if (!model) {
    throw rpcError(
      "BAD_REQUEST",
      "error.knowledgeNoModel",
      "Uploads need an OpenAI or Gemini key. Add a key",
    );
  }
  // Host credentials count against the user's Quota, so an upload past it is refused (ADR 0007).
  // Files already processing aren't checked again: they finish.
  if (!(await model.meter.mayRun()).ok) {
    throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
  }

  const id = uuidv7();
  const key = knowledgeBlobKey(id);
  await deps.blobStore.put(key, file.bytes, { contentType: file.mediaType });
  try {
    const info = await deps.db.transaction(async (tx) => {
      // Locks the Project row, so two uploads at once can't both pass the file limit.
      await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId))
        .for("update");
      if ((await countFiles(tx, projectId)) >= knowledgeFilesPerProject) {
        throw rpcError(
          "BAD_REQUEST",
          "error.knowledgeFileLimit",
          `A Project can hold at most ${knowledgeFilesPerProject} Knowledge files`,
          { max: knowledgeFilesPerProject },
        );
      }
      const [created] = await tx
        .insert(knowledgeFile)
        .values({
          id,
          userId,
          projectId,
          name: file.name,
          mediaType: file.mediaType,
          size: file.bytes.byteLength,
        })
        .returning(infoColumns);
      if (!row.embeddingModel) {
        await tx.update(project).set({ embeddingModel: model.id }).where(eq(project.id, projectId));
      }
      if (!created) throw new Error("Saving the Knowledge file returned no row");
      return created;
    });
    await deps
      .plugin("runner")
      .enqueue(knowledgeProcessJob.name, { fileId: id }, { idempotencyKey: knowledgeJobKey(id) });
    return info;
  } catch (error) {
    await deleteBlobsBestEffort(deps, [key]);
    throw error;
  }
}

/**
 * Sets the Project's embedding Model. It can change only while the Project has no Knowledge files,
 * and only to a Model the user can use now (ADR 0014).
 */
export async function setKnowledgeModel(
  deps: BotSdkContext,
  userId: string,
  projectId: string,
  model: string,
): Promise<void> {
  if (!(await findProject(deps, userId, projectId))) {
    throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
  }
  if (!(await deps.plugin("models").resolveEmbeddingModel(userId, model))) {
    throw rpcError(
      "BAD_REQUEST",
      "error.knowledgeModelNotAvailable",
      `"${model}" is not an available embedding Model`,
      { model },
    );
  }
  await deps.db.transaction(async (tx) => {
    await tx
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.userId, userId)))
      .for("update");
    if ((await countFiles(tx, projectId)) > 0) {
      throw rpcError(
        "CONFLICT",
        "error.knowledgeModelLocked",
        "The embedding Model is fixed once the Project has Knowledge files",
      );
    }
    await tx.update(project).set({ embeddingModel: model }).where(eq(project.id, projectId));
  });
}

/** The file's status, once the Project is the user's and the file is in it. */
async function ownedFileStatus(
  deps: BotSdkContext,
  userId: string,
  projectId: string,
  fileId: string,
) {
  if (!(await findProject(deps, userId, projectId))) {
    throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
  }
  const [file] = await deps.db
    .select({ status: knowledgeFile.status })
    .from(knowledgeFile)
    .where(and(eq(knowledgeFile.id, fileId), eq(knowledgeFile.projectId, projectId)));
  if (!file) throw rpcError("NOT_FOUND", "error.knowledgeFileNotFound", "Knowledge file not found");
  return file;
}

/**
 * Queues a Failed file's processing again. Its original bytes are still in the blob store, so
 * nothing is re-uploaded, and the job starts with fresh attempts.
 */
export async function retryKnowledgeFile(
  deps: BotSdkContext,
  userId: string,
  projectId: string,
  fileId: string,
): Promise<void> {
  const notFailed = () =>
    rpcError(
      "CONFLICT",
      "error.knowledgeFileNotFailed",
      "Only a Knowledge file that failed can be retried",
    );
  const file = await ownedFileStatus(deps, userId, projectId, fileId);
  if (file.status !== "failed") throw notFailed();
  const reset = await deps.db
    .update(knowledgeFile)
    .set({ status: "processing", failureCode: null, chunkCount: null })
    .where(and(eq(knowledgeFile.id, fileId), eq(knowledgeFile.status, "failed")))
    .returning({ id: knowledgeFile.id });
  if (reset.length === 0) throw notFailed();
  await deps
    .plugin("runner")
    .enqueue(knowledgeProcessJob.name, { fileId }, { idempotencyKey: knowledgeJobKey(fileId) });
}

/**
 * Deletes a Knowledge file whatever its status. Its job is cancelled first; a job already running
 * stops at its next write, since the passages are only written while the file row exists. The file
 * row and its passages go in one transaction, then the bytes (best-effort, after the commit).
 */
export async function deleteKnowledgeFile(
  deps: BotSdkContext,
  userId: string,
  projectId: string,
  fileId: string,
): Promise<void> {
  await ownedFileStatus(deps, userId, projectId, fileId);
  await deps.plugin("runner").cancel(knowledgeJobKey(fileId));
  await deps.db.transaction(async (tx) => {
    // Locks the file row, so a passage write in progress finishes before its passages go.
    await tx
      .select({ id: knowledgeFile.id })
      .from(knowledgeFile)
      .where(eq(knowledgeFile.id, fileId))
      .for("update");
    await tx.delete(knowledgeChunk).where(eq(knowledgeChunk.fileId, fileId));
    await tx.delete(knowledgeFile).where(eq(knowledgeFile.id, fileId));
  });
  await deleteBlobsBestEffort(deps, [knowledgeBlobKey(fileId)]);
}
