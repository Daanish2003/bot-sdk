import { and, asc, eq, sql } from "drizzle-orm";

import { project } from "../db/schema/chat";
import { knowledgeChunk, knowledgeFile } from "../db/schema/knowledge";
import {
  type ResolvedEmbeddingModel,
  embedTexts,
  resolveEmbeddingModel,
} from "../chat/embedding-models";
import type { AppDeps } from "../deps";
import { maxExcerptsPerSearch } from "../../shared/chat/knowledge-search";

/** Passages each leg of the hybrid search takes before fusion (spec #357, ticket #206). */
export const candidatesPerLeg = 40;

/** The `k` of reciprocal-rank fusion (spec #357). */
const rrfK = 60;

/** Most Knowledge file names a Project's prompt line lists (spec #357). */
const maxFileNames = 100;

/** A passage a search found, snapshotted as the `knowledge_search` part stores it. */
export type Excerpt = { fileId: string; fileName: string; chunkIndex: number; text: string };

/**
 * What a Conversation's Project lets the assistant search: the names of its ready Knowledge files
 * and the embedding Model they're searched with. `null` when there is no such Knowledge (no Project,
 * no ready file) or no working credential for its Model, so the tool isn't offered (spec #357).
 */
export async function knowledgeSearchFor(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "hostProviders" | "byok">,
  userId: string,
  projectId: string,
): Promise<{ fileNames: string[]; model: ResolvedEmbeddingModel } | null> {
  const [row] = await deps.db
    .select({ embeddingModel: project.embeddingModel })
    .from(project)
    .where(eq(project.id, projectId));
  if (!row?.embeddingModel) return null;
  const files = await deps.db
    .select({ name: knowledgeFile.name })
    .from(knowledgeFile)
    .where(and(eq(knowledgeFile.projectId, projectId), eq(knowledgeFile.status, "ready")))
    .orderBy(asc(knowledgeFile.createdAt), asc(knowledgeFile.id))
    .limit(maxFileNames);
  if (files.length === 0) return null;
  const model = await resolveEmbeddingModel(deps, userId, row.embeddingModel);
  if (!model) return null;
  return { fileNames: files.map((file) => file.name), model };
}

/**
 * The best passages of a Project's ready Knowledge files for `query`: the nearest by meaning and
 * the best matches by keyword, each leg's top candidates fused by reciprocal rank (spec #357). The
 * query is embedded with the Project's Model, metered on Host credentials by `embedTexts`.
 */
export async function searchPassages(
  deps: Pick<AppDeps, "db" | "hooks" | "embeddingAdapterFor">,
  {
    userId,
    projectId,
    model,
    query,
  }: { userId: string; projectId: string; model: ResolvedEmbeddingModel; query: string },
): Promise<Excerpt[]> {
  const [vector] = await embedTexts(deps, { userId, model, texts: [query], purpose: "query" });
  const literal = JSON.stringify(vector);
  const scope = and(eq(knowledgeFile.projectId, projectId), eq(knowledgeFile.status, "ready"));
  const columns = {
    fileId: knowledgeChunk.fileId,
    fileName: knowledgeFile.name,
    chunkIndex: knowledgeChunk.position,
    text: knowledgeChunk.text,
  };
  const keywordQuery = sql`websearch_to_tsquery('english', ${query})`;

  // The vector leg needs iterative scans to keep finding rows past the Project filter (pgvector 0.8).
  const byMeaning = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    return tx
      .select(columns)
      .from(knowledgeChunk)
      .innerJoin(knowledgeFile, eq(knowledgeChunk.fileId, knowledgeFile.id))
      .where(scope)
      .orderBy(
        sql`${knowledgeChunk.embedding} <=> ${literal}::vector`,
        asc(knowledgeChunk.fileId),
        asc(knowledgeChunk.position),
      )
      .limit(candidatesPerLeg);
  });
  const byKeyword = await deps.db
    .select(columns)
    .from(knowledgeChunk)
    .innerJoin(knowledgeFile, eq(knowledgeChunk.fileId, knowledgeFile.id))
    .where(and(scope, sql`${knowledgeChunk.tsv} @@ ${keywordQuery}`))
    .orderBy(
      sql`ts_rank_cd(${knowledgeChunk.tsv}, ${keywordQuery}) desc`,
      asc(knowledgeChunk.fileId),
      asc(knowledgeChunk.position),
    )
    .limit(candidatesPerLeg);

  return fuseByReciprocalRank(
    [byMeaning, byKeyword],
    (excerpt) => `${excerpt.fileId}:${excerpt.chunkIndex}`,
  ).slice(0, maxExcerptsPerSearch);
}

/**
 * Reciprocal-rank fusion (spec #357): each item scores the sum of 1 / (k + rank) over the lists it
 * appears in, ranks from 1, with equal weights. The best first; ties keep their first appearance.
 */
export function fuseByReciprocalRank<T>(lists: T[][], keyOf: (item: T) => string, k = rrfK): T[] {
  const scores = new Map<string, { item: T; score: number; order: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item);
      const entry = scores.get(key) ?? { item, score: 0, order: scores.size };
      entry.score += 1 / (k + index + 1);
      scores.set(key, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item);
}
