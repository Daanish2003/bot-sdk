import { conversation, message } from "../db/schema/chat";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDeps } from "../deps";
import { escapeLike, snippetAround } from "../../shared/search/text";

type Deps = Pick<AppDeps, "db">;

/** Hits per page. */
export const searchPageSize = 50;

/**
 * Where the next page starts: the last hit's `createdAt` as Postgres prints it (full precision,
 * which a JS `Date` would lose) and its id.
 */
const cursorShape = z.object({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/),
  id: z.uuid(),
});
type Cursor = z.infer<typeof cursorShape>;

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The decoded cursor, or `undefined` when it isn't one this module wrote. */
export function decodeCursor(cursor: string): Cursor | undefined {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  } catch {
    return undefined;
  }
}

/**
 * Narrows a search. `model` and `provider` match the Model that wrote an assistant Message, so
 * user Messages never match them. `from` is inclusive and `to` exclusive, both on the Message's
 * date. Every filter is optional and they combine with AND.
 */
export type SearchFilters = {
  /** A `"provider:model"` id. */
  model?: string;
  /** A Provider id: the part of a Model id before its `:`. */
  provider?: string;
  from?: Date;
  to?: Date;
  /** A Project id: only Messages in its Conversations. */
  projectId?: string;
};

/**
 * The user's Messages whose text contains `q` (case-insensitive, literally), on every Branch and
 * in any status, newest first, one row per Message with a plain-text snippet around the match.
 */
export async function searchMessages(
  deps: Deps,
  userId: string,
  q: string,
  cursor?: Cursor,
  filters: SearchFilters = {},
) {
  const createdAtText = sql<string>`${message.createdAt}::text`;
  const rows = await deps.db
    .select({
      messageId: message.id,
      conversationId: message.conversationId,
      conversationTitle: conversation.title,
      role: message.role,
      createdAt: message.createdAt,
      createdAtText,
      searchText: message.searchText,
    })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(conversation.userId, userId),
        ilike(message.searchText, `%${escapeLike(q)}%`),
        cursor &&
          sql`(${message.createdAt}, ${message.id}) < (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)`,
        filters.model === undefined
          ? undefined
          : and(eq(message.role, "assistant"), eq(message.model, filters.model)),
        filters.provider === undefined
          ? undefined
          : and(
              eq(message.role, "assistant"),
              sql`split_part(${message.model}, ':', 1) = ${filters.provider}`,
            ),
        // Dates are stored as UTC wall-clock time (as the app writes them), so compare with the UTC ISO text.
        filters.from === undefined
          ? undefined
          : sql`${message.createdAt} >= ${filters.from.toISOString()}::timestamp`,
        filters.to === undefined
          ? undefined
          : sql`${message.createdAt} < ${filters.to.toISOString()}::timestamp`,
        filters.projectId === undefined ? undefined : eq(conversation.projectId, filters.projectId),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(searchPageSize + 1);

  const page = rows.slice(0, searchPageSize);
  const last = page.at(-1);
  return {
    hits: page.map((row) => ({
      messageId: row.messageId,
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      role: row.role,
      createdAt: row.createdAt,
      snippet: snippetAround(row.searchText, q),
    })),
    nextCursor:
      rows.length > searchPageSize && last
        ? encodeCursor({ createdAt: last.createdAtText, id: last.messageId })
        : null,
  };
}
