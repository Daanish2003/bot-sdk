import { sql, eq } from "drizzle-orm";

import type { PastChatsSearchPart } from "../../shared/message-parts";
import {
  maxPastChats,
  maxSnippetsPerChat,
  pastChatSnippetLength,
} from "../../shared/chat/past-chats";
import { snippetAround } from "../../shared/search/text";
import { userSettings } from "../db/schema/settings";
import type { AppDeps } from "../deps";

type Deps = Pick<AppDeps, "db" | "memory">;

/** The Conversations a `search_past_chats` call found, each with its snippets (spec #263). */
export type PastChatHit = PastChatsSearchPart["conversations"][number];

/**
 * Whether the assistant may search past chats for this user's Run: Memory is on for the Host and
 * for the user, and the Conversation is not Temporary (spec #263). Memory on by default.
 */
export async function pastChatsOffered(
  deps: Deps,
  userId: string,
  temporary: boolean,
): Promise<boolean> {
  if (!deps.memory || temporary) return false;
  const [row] = await deps.db
    .select({ memoryEnabled: userSettings.memoryEnabled })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return row?.memoryEnabled ?? true;
}

/** The words of a query that a snippet can centre on: the first one the text holds. */
function termIn(text: string, query: string): string {
  const words = query
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  return words.find((word) => text.toLowerCase().includes(word.toLowerCase())) ?? "";
}

type Row = {
  conversation_id: string;
  title: string;
  message_id: string;
  search_text: string;
  created_at: string;
  rn: number;
};

/**
 * Finds the Conversations whose Active Branch matches `query` (Postgres full-text search, every
 * word must match, anywhere in the text), for a Run in `scope` (spec #263).
 *
 * A Run in a Project searches that Project's Conversations and the general ones; a general Run
 * only the general ones. Temporary Conversations and the current one are never searched. Each
 * Conversation is ranked by its best match, and returns up to `maxSnippetsPerChat` matching
 * Messages as snippets; at most `maxPastChats` Conversations come back.
 */
export async function searchPastChats(
  deps: Deps,
  {
    userId,
    conversationId,
    projectId,
  }: { userId: string; conversationId: string; projectId: string | null },
  query: string,
): Promise<PastChatHit[]> {
  const result = await deps.db.execute<Row>(sql`
    WITH RECURSIVE scoped AS (
      SELECT c.id, COALESCE(c.title, '') AS title, c.active_leaf_id
      FROM chat.conversation c
      WHERE c.user_id = ${userId}
        AND c.temporary = false
        AND c.id <> ${conversationId}
        AND c.active_leaf_id IS NOT NULL
        AND (c.project_id IS NULL OR c.project_id = ${projectId})
    ),
    branch AS (
      SELECT s.id AS conversation_id, m.id, m.parent_id
      FROM scoped s
      JOIN chat.message m ON m.id = s.active_leaf_id
      UNION ALL
      SELECT b.conversation_id, m.id, m.parent_id
      FROM branch b
      JOIN chat.message m ON m.id = b.parent_id
    ),
    q AS (
      SELECT websearch_to_tsquery('simple', ${query}) AS query
    ),
    hits AS (
      SELECT b.conversation_id, m.id AS message_id, m.search_text, m.created_at,
        ts_rank_cd(to_tsvector('simple', m.search_text), q.query) AS rank
      FROM branch b
      JOIN chat.message m ON m.id = b.id
      CROSS JOIN q
      WHERE to_tsvector('simple', m.search_text) @@ q.query
    ),
    ranked AS (
      SELECT h.conversation_id, h.message_id, h.search_text, h.created_at, h.rank,
        ROW_NUMBER() OVER (
          PARTITION BY h.conversation_id ORDER BY h.rank DESC, h.created_at DESC, h.message_id
        ) AS rn
      FROM hits h
    ),
    top AS (
      SELECT r.conversation_id, r.rank AS best_rank, r.created_at AS best_at
      FROM ranked r
      WHERE r.rn = 1
      ORDER BY r.rank DESC, r.created_at DESC, r.conversation_id
      LIMIT ${maxPastChats}
    )
    SELECT r.conversation_id, s.title, r.message_id, r.search_text, r.created_at::text AS created_at, r.rn
    FROM ranked r
    JOIN top t ON t.conversation_id = r.conversation_id
    JOIN scoped s ON s.id = r.conversation_id
    WHERE r.rn <= ${maxSnippetsPerChat}
    ORDER BY t.best_rank DESC, t.best_at DESC, r.conversation_id, r.rn
  `);

  const found = new Map<string, PastChatHit>();
  for (const row of result.rows) {
    const hit = found.get(row.conversation_id) ?? {
      conversationId: row.conversation_id,
      title: row.title,
      date: new Date(`${row.created_at.replace(" ", "T")}Z`).toISOString(),
      snippets: [],
    };
    const term = termIn(row.search_text, query);
    hit.snippets.push(snippetAround(row.search_text, term, pastChatSnippetLength).text);
    found.set(row.conversation_id, hit);
  }
  return [...found.values()];
}
