import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { defaultEmbeddingModel, embedTexts } from "../chat/embedding-models";
import { quotaRefusal } from "../chat/quota";
import { conversation, project } from "../db/schema/chat";
import { memory } from "../db/schema/memory";
import { userSettings } from "../db/schema/settings";
import type { AppDeps } from "../deps";
import { defineJob } from "../jobs/define";
import { rpcError } from "../rpc-error";

/** What the Memory page shows about the user's Memories and whether Memory can work. */
export type MemoryStatus = {
  /** Whether the Host turns Memory on (`createChat({ memory })`). */
  hostEnabled: boolean;
  /** The user's "Use and make Memories" switch. */
  enabled: boolean;
  /** Whether an embedding Model is available to the user, which Memory needs. */
  embeddingAvailable: boolean;
};

/** One Memory as the Memory page lists it: valid only, with the Conversation it came from. */
export type ListedMemory = {
  id: string;
  text: string;
  origin: "extracted" | "said";
  createdAt: Date;
  conversationId: string;
  conversationTitle: string | null;
  sourceMessageId: string;
};

/** The Memories of one scope: general (`projectId` null) or one Project. */
export type MemoryGroup = {
  projectId: string | null;
  projectName: string | null;
  items: ListedMemory[];
};

/** Refuses the procedures when the Host has turned Memory off, so the page can't reach them. */
export function requireHostMemory(deps: Pick<AppDeps, "memory">) {
  if (!deps.memory) throw rpcError("NOT_FOUND", "error.memoryOff", "Memory is off for this Host");
}

/** The user's Memory switch and whether an embedding Model is there for it. */
export async function memoryStatus(deps: AppDeps, userId: string): Promise<MemoryStatus> {
  const [settings] = await deps.db
    .select({ memoryEnabled: userSettings.memoryEnabled })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  const embedding = deps.memory ? await defaultEmbeddingModel(deps, userId) : null;
  return {
    hostEnabled: deps.memory,
    enabled: settings?.memoryEnabled ?? true,
    embeddingAvailable: embedding !== null,
  };
}

/** Saves the "Use and make Memories" switch. Off keeps every Memory; it only stops using and making them. */
export async function setMemoryEnabled(deps: AppDeps, userId: string, enabled: boolean) {
  await deps.db
    .insert(userSettings)
    .values({ userId, memoryEnabled: enabled })
    .onConflictDoUpdate({ target: userSettings.userId, set: { memoryEnabled: enabled } });
}

/**
 * The user's valid Memories, grouped General first and then by Project, the newest first in each
 * group. Outdated Memories are left out.
 */
export async function listMemories(deps: AppDeps, userId: string): Promise<MemoryGroup[]> {
  const rows = await deps.db
    .select({
      id: memory.id,
      text: memory.text,
      origin: memory.origin,
      createdAt: memory.createdAt,
      conversationId: memory.conversationId,
      conversationTitle: conversation.title,
      sourceMessageId: memory.sourceMessageId,
      projectId: conversation.projectId,
      projectName: project.name,
    })
    .from(memory)
    .innerJoin(conversation, eq(conversation.id, memory.conversationId))
    .leftJoin(project, eq(project.id, conversation.projectId))
    .where(and(eq(memory.userId, userId), isNull(memory.invalidAt)))
    .orderBy(desc(memory.createdAt));

  const groups = new Map<string, MemoryGroup>();
  for (const row of rows) {
    const key = row.projectId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { projectId: row.projectId, projectName: row.projectName, items: [] };
      groups.set(key, group);
    }
    group.items.push({
      id: row.id,
      text: row.text,
      origin: row.origin,
      createdAt: row.createdAt,
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      sourceMessageId: row.sourceMessageId,
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.projectId === null) return -1;
    if (b.projectId === null) return 1;
    return (a.projectName ?? "").localeCompare(b.projectName ?? "");
  });
}

/** The one embedding Model's error, shown where a Memory needs embeddings. */
const noEmbeddingModel = () =>
  rpcError(
    "BAD_REQUEST",
    "error.memoryNeedsEmbeddingModel",
    "Memory needs an embedding Model. Add an OpenAI or Gemini key.",
  );

/**
 * Changes a valid Memory's text. It is embedded again with the user's embedding Model and keeps
 * its source Message and Conversation.
 */
export async function editMemory(deps: AppDeps, userId: string, id: string, text: string) {
  const [row] = await deps.db
    .select({ id: memory.id })
    .from(memory)
    .where(and(eq(memory.id, id), eq(memory.userId, userId), isNull(memory.invalidAt)));
  if (!row) throw rpcError("NOT_FOUND", "error.memoryNotFound", "Memory not found");
  const embedding = await defaultEmbeddingModel(deps, userId);
  if (!embedding) throw noEmbeddingModel();
  const [vector] = await embedTexts(deps, {
    userId,
    model: embedding,
    texts: [text],
    purpose: "document",
  });
  await deps.db
    .update(memory)
    .set({
      text,
      embedding: vector!,
      embeddingModel: embedding.id,
      updatedAt: deps.clock(),
    })
    .where(eq(memory.id, id));
}

/** Hard-deletes one of the user's Memories, valid or outdated. */
export async function deleteMemory(deps: AppDeps, userId: string, id: string) {
  const removed = await deps.db
    .delete(memory)
    .where(and(eq(memory.id, id), eq(memory.userId, userId)))
    .returning({ id: memory.id });
  if (removed.length === 0) throw rpcError("NOT_FOUND", "error.memoryNotFound", "Memory not found");
}

/** Hard-deletes every Memory the user has, valid or outdated. */
export async function deleteAllMemories(deps: AppDeps, userId: string) {
  await deps.db.delete(memory).where(eq(memory.userId, userId));
}

/** The payload of a re-embed: the user whose Memories were made with another embedding Model. */
const reembedPayload = z.object({ userId: z.string() });

/**
 * Embeds again the user's valid Memories that were made with another embedding Model, so every
 * Memory is compared in the same vector space. Ends quietly when the user has no embedding Model
 * or is over Quota on Host credentials. It holds the user's Memory lock, as making Memories does.
 */
export const reembedMemoriesJob = defineJob<z.infer<typeof reembedPayload>>({
  name: "memory.reembed",
  payload: reembedPayload,
  run: async ({ userId }, { deps }) => {
    const embedding = await defaultEmbeddingModel(deps, userId);
    if (!embedding) return;
    if (embedding.onHostCredentials && (await quotaRefusal(deps, userId))) return;
    await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${userId}`}, 0))`,
      );
      const stale = await tx
        .select({ id: memory.id, text: memory.text })
        .from(memory)
        .where(
          and(
            eq(memory.userId, userId),
            isNull(memory.invalidAt),
            sql`${memory.embeddingModel} <> ${embedding.id}`,
          ),
        );
      if (stale.length === 0) return;
      const vectors = await embedTexts(deps, {
        userId,
        model: embedding,
        texts: stale.map((row) => row.text),
        purpose: "document",
      });
      for (const [i, row] of stale.entries()) {
        await tx
          .update(memory)
          .set({ embedding: vectors[i]!, embeddingModel: embedding.id })
          .where(eq(memory.id, row.id));
      }
    });
  },
});
