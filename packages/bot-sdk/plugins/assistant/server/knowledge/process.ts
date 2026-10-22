import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { knowledgeBlobKey } from "../blob-keys";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { project, knowledgeChunk, knowledgeFile } from "../../../../core/server/db/schema";
import { defineJob, PermanentJobError } from "../../../runner/server/jobs/define";
import type { KnowledgeFailureCode } from "../../shared/knowledge/kinds";
import { ChunkLimitExceededError, chunkText } from "./chunker";
import { ExtractionFailure, extractKnowledgeText } from "../../../knowledge/server/index";

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

/** The idempotency key of a file's processing job, so Delete and Retry can find it. */
export const knowledgeJobKey = (fileId: string) => `knowledge:${fileId}`;

/**
 * Reads a Knowledge file, splits it into passages, embeds them with the Project's embedding Model
 * and stores them, then marks the file ready with its passage count. A file deleted meanwhile is
 * left alone. Passages from an earlier attempt are replaced, so a retry starts clean.
 */
export const knowledgeProcessJob = defineJob({
  name: "knowledge.process",
  payload: z.object({ fileId: z.uuid() }),
  run: async ({ fileId }, { deps, signal }) => {
    const [file] = await deps.db.select().from(knowledgeFile).where(eq(knowledgeFile.id, fileId));
    if (!file || file.status !== "processing") return;

    const bytes = await deps.blobStore.get(knowledgeBlobKey(fileId));
    if (!bytes) throw new KnowledgeFailure("unreadable");
    let text: string;
    try {
      text = await extractKnowledgeText(file.mediaType, bytes);
    } catch (error) {
      if (error instanceof ExtractionFailure) throw new KnowledgeFailure(error.code);
      throw error;
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
      ? await deps.plugin("models").resolveEmbeddingModel(file.userId, owner.embeddingModel)
      : null;
    if (!model) throw new KnowledgeFailure("no_credentials");

    if (!(await storePassages(deps, fileId, [], { replace: true }))) return;
    for (let start = 0; start < chunks.length; start += passageBatch) {
      if (signal.aborted) return;
      const batch = chunks.slice(start, start + passageBatch);
      const vectors = await deps.plugin("models").embedTexts({
        model,
        texts: batch.map((chunk) => chunk.text),
        purpose: "document",
      });
      const stored = await storePassages(
        deps,
        fileId,
        batch.map((chunk, offset) => ({
          fileId,
          position: start + offset,
          text: chunk.text,
          embedding: vectors[offset]!,
        })),
        { replace: false },
      );
      if (!stored) return;
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

/**
 * Writes passages for a file that is still processing, in one transaction that holds the file's
 * row, so a delete can't land between the check and the write. `replace` clears the passages of an
 * earlier attempt first. False when the file was deleted or has left `processing`: nothing is
 * written, and the job stops quietly.
 */
async function storePassages(
  deps: Pick<BotSdkContext, "db">,
  fileId: string,
  passages: (typeof knowledgeChunk.$inferInsert)[],
  { replace }: { replace: boolean },
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [file] = await tx
      .select({ status: knowledgeFile.status })
      .from(knowledgeFile)
      .where(eq(knowledgeFile.id, fileId))
      .for("share");
    if (file?.status !== "processing") return false;
    if (replace) await tx.delete(knowledgeChunk).where(eq(knowledgeChunk.fileId, fileId));
    if (passages.length > 0) await tx.insert(knowledgeChunk).values(passages);
    return true;
  });
}

/** Marks a file failed, unless it has already left `processing` (or was deleted). */
async function markFailed(
  deps: Pick<BotSdkContext, "db">,
  fileId: string,
  code: KnowledgeFailureCode,
) {
  await deps.db
    .update(knowledgeFile)
    .set({ status: "failed", failureCode: code })
    .where(and(eq(knowledgeFile.id, fileId), eq(knowledgeFile.status, "processing")));
}
