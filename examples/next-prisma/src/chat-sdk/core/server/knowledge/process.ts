import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { knowledgeBlobKey } from "../blob/store";
import type { AppDeps } from "../deps";
import { project } from "../db/schema/chat";
import { knowledgeChunk, knowledgeFile } from "../db/schema/knowledge";
import { embedTexts, resolveEmbeddingModel } from "../chat/embedding-models";
import { defineJob, PermanentJobError } from "../jobs/define";
import type { KnowledgeFailureCode } from "../../shared/knowledge/kinds";
import { ChunkLimitExceededError, chunkText } from "./chunker";

/** Passages per embedding call and per insert: the most texts one step holds in memory. */
const passageBatch = 100;

/** The chunker's settings (spec #357): 1,024-token passages, 200 shared, at least 100 characters. */
const chunking = {
  chunkSize: 1024,
  chunkOverlap: 200,
  minCharactersPerChunk: 100,
  maxChunks: 5000,
};

/**
 * A failure retrying can't fix. Its code is the reason the file shows as failed. It fails the job
 * at once (ADR 0011).
 */
export class KnowledgeFailure extends PermanentJobError {
  readonly code: KnowledgeFailureCode;

  constructor(code: KnowledgeFailureCode) {
    super(`Knowledge file failed: ${code}`);
    this.code = code;
  }
}

/**
 * Reads a Knowledge file, splits it into passages, embeds them with the Project's embedding Model
 * and stores them, then marks the file ready with its passage count. A file deleted meanwhile is
 * left alone. Passages from an earlier attempt are replaced, so a retry starts clean.
 */
export const knowledgeProcessJob = defineJob({
  name: "knowledge.process",
  payload: z.object({ fileId: z.uuid() }),
  run: async ({ fileId }, { deps }) => {
    const [file] = await deps.db.select().from(knowledgeFile).where(eq(knowledgeFile.id, fileId));
    if (!file || file.status !== "processing") return;

    const bytes = await deps.blobStore.get(knowledgeBlobKey(fileId));
    if (!bytes) throw new KnowledgeFailure("unreadable");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeFailure("unreadable");
    }

    let chunks: { text: string }[];
    try {
      chunks = chunkText(text, chunking);
    } catch (error) {
      if (error instanceof ChunkLimitExceededError) throw new KnowledgeFailure("too_large");
      throw error;
    }
    if (chunks.length === 0) throw new KnowledgeFailure("no_text");

    const [owner] = await deps.db
      .select({ embeddingModel: project.embeddingModel })
      .from(project)
      .where(eq(project.id, file.projectId));
    const model = owner?.embeddingModel
      ? await resolveEmbeddingModel(deps, file.userId, owner.embeddingModel)
      : null;
    if (!model) throw new KnowledgeFailure("no_credentials");

    await deps.db.delete(knowledgeChunk).where(eq(knowledgeChunk.fileId, fileId));
    for (let start = 0; start < chunks.length; start += passageBatch) {
      const batch = chunks.slice(start, start + passageBatch);
      const vectors = await embedTexts(deps, {
        userId: file.userId,
        model,
        texts: batch.map((chunk) => chunk.text),
        purpose: "document",
      });
      await deps.db.insert(knowledgeChunk).values(
        batch.map((chunk, offset) => ({
          fileId,
          position: start + offset,
          text: chunk.text,
          embedding: vectors[offset]!,
        })),
      );
    }

    await deps.db
      .update(knowledgeFile)
      .set({ status: "ready", chunkCount: chunks.length, failureCode: null })
      .where(eq(knowledgeFile.id, fileId));
  },
  onFailed: async ({ fileId }, error, deps) => {
    await markFailed(deps, fileId, error instanceof KnowledgeFailure ? error.code : "failed");
  },
});

/** Marks a file failed, unless it has already left `processing` (or was deleted). */
async function markFailed(deps: Pick<AppDeps, "db">, fileId: string, code: KnowledgeFailureCode) {
  await deps.db
    .update(knowledgeFile)
    .set({ status: "failed", failureCode: code })
    .where(and(eq(knowledgeFile.id, fileId), eq(knowledgeFile.status, "processing")));
}
