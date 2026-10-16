import { and, desc, eq, isNull, notInArray, or, sql } from "drizzle-orm";

import { defaultEmbeddingModel, embedTexts } from "../chat/embedding-models";
import { conversation, memory, userSettings } from "../db/schema";
import type { AppDeps } from "../deps";

/** With this many valid Memories in scope or fewer, all are sent and nothing is embedded (ADR 0013). */
const allCount = 30;
/** The newest Memories every Run sends, the profile (ADR 0013). */
const profileCount = 20;
const profileTokens = 400;
/** The Memories closest to the latest Message, sent beside the profile (ADR 0013). */
const similarCount = 10;
const similarTokens = 600;

/** The header of the Memories block: what the Model is told about the Memories it reads (ADR 0013). */
const memoriesHeader =
  "Memories\n\nThese are facts learned about the user in earlier Conversations, each dated when it was learned. They may be outdated. Where they conflict with the Instructions, the Instructions win. Anything the user asks you to remember or forget is saved or forgotten right after your reply.";

/** A valid Memory as the recall reads it. */
type Recalled = { id: string; text: string; createdAt: Date };

/** The estimate the token caps use: a fourth of the characters, as `embedTexts` estimates. */
const tokensOf = (line: string) => Math.ceil(line.length / 4);

/** The rows that fit in `tokens`, in order; the first that doesn't fit ends the list. */
function within(rows: Recalled[], tokens: number): Recalled[] {
  let used = 0;
  const kept: Recalled[] = [];
  for (const row of rows) {
    used += tokensOf(row.text);
    if (used > tokens) break;
    kept.push(row);
  }
  return kept;
}

/**
 * The valid Memories a Run sees: a Project Run sees its Project's and the general ones, a general
 * Run only the general ones (ADR 0013). The scope is the Conversation's current Project, through a
 * join, so moving a Conversation moves its Memories.
 */
function inScope(userId: string, projectId: string | null) {
  return and(
    eq(memory.userId, userId),
    isNull(memory.invalidAt),
    projectId === null
      ? isNull(conversation.projectId)
      : or(isNull(conversation.projectId), eq(conversation.projectId, projectId)),
  );
}

const recalledColumns = {
  id: memory.id,
  text: memory.text,
  createdAt: memory.createdAt,
};

/**
 * The Memories block of a Run's system prompts, or `null` when the Run recalls none (ADR 0013).
 * Off for a Temporary Conversation and when Memory is off for the Host or the user. With 30 or
 * fewer valid Memories in scope, all are sent. Past that, the 20 newest make the profile and the
 * 10 closest to `latestText` the rest, found with the user's embedding Model. When the embedding
 * fails, or there is none, the Run goes ahead with the profile only.
 */
export async function recalledMemoriesPrompt(
  deps: AppDeps,
  {
    userId,
    projectId,
    temporary,
    latestText,
  }: {
    userId: string;
    /** The Conversation's Project; null for a general Conversation. */
    projectId: string | null;
    temporary: boolean;
    /** The latest user Message's text, which the similar Memories are found by. */
    latestText: string | null;
  },
): Promise<string | null> {
  if (!deps.memory || temporary) return null;
  const [settings] = await deps.db
    .select({ memoryEnabled: userSettings.memoryEnabled })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  if (settings && !settings.memoryEnabled) return null;

  const scope = inScope(userId, projectId);
  const newest = await deps.db
    .select(recalledColumns)
    .from(memory)
    .innerJoin(conversation, eq(conversation.id, memory.conversationId))
    .where(scope)
    .orderBy(desc(sql`greatest(${memory.createdAt}, ${memory.updatedAt})`))
    .limit(allCount + 1);
  if (newest.length === 0) return null;

  let recalled: Recalled[];
  if (newest.length <= allCount) {
    recalled = newest;
  } else {
    const profile = within(newest.slice(0, profileCount), profileTokens);
    const similar = latestText
      ? await similarMemories(deps, {
          userId,
          scope,
          latestText,
          exclude: profile.map((r) => r.id),
        })
      : [];
    recalled = [...profile, ...similar];
  }
  const lines = recalled.map(
    (row) => `- ${row.createdAt.toISOString().slice(0, 10)}: ${row.text.replace(/\s+/g, " ")}`,
  );
  return [memoriesHeader, ...lines].join("\n");
}

/**
 * The valid Memories in scope closest to `latestText`, not among `exclude`, within the token cap.
 * Any failure to embed the text gives none, so the Run keeps its profile.
 */
async function similarMemories(
  deps: AppDeps,
  {
    userId,
    scope,
    latestText,
    exclude,
  }: {
    userId: string;
    scope: ReturnType<typeof inScope>;
    latestText: string;
    exclude: string[];
  },
): Promise<Recalled[]> {
  try {
    const model = await defaultEmbeddingModel(deps, userId);
    if (!model) return [];
    const [vector] = await embedTexts(deps, {
      model,
      texts: [latestText],
      purpose: "query",
    });
    const rows = await deps.db
      .select(recalledColumns)
      .from(memory)
      .innerJoin(conversation, eq(conversation.id, memory.conversationId))
      .where(exclude.length > 0 ? and(scope, notInArray(memory.id, exclude)) : scope)
      .orderBy(sql`${memory.embedding} <=> ${JSON.stringify(vector!)}::vector`)
      .limit(similarCount);
    return within(rows, similarTokens);
  } catch {
    return [];
  }
}
