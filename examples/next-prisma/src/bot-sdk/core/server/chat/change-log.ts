import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import type { Database } from "../db/index";
import { conversation, conversationChange } from "../db/schema";
import type { Transaction } from "../plugin";

/** How many of a Conversation's newest changes its change log keeps (ADR 0026). */
export const retainedChanges = 500;

/** One change as the log holds it. */
export type LoggedChange = { seq: number; kind: string; refId: string; at: Date };

/**
 * Records one change to what Conversation `conversationId`'s thread shows (ADR 0026), in `tx`: bumps
 * its `last_seq` under its row lock, writes the change with that seq, and drops the changes older
 * than the newest `retainedChanges`. The lock holds until `tx` commits, so the Conversation's
 * changes commit in seq order, and a rolled-back change gives its seq back. Every write that
 * changes the thread calls it in its own transaction. Returns the change's seq.
 */
export async function recordChange(
  tx: Transaction,
  conversationId: string,
  change: { kind: string; refId: string; at: Date },
): Promise<number> {
  const [bumped] = await tx
    .update(conversation)
    // `updated_at` stays: a change to the thread isn't an edit of the Conversation.
    .set({ lastSeq: sql`${conversation.lastSeq} + 1`, updatedAt: sql`${conversation.updatedAt}` })
    .where(eq(conversation.id, conversationId))
    .returning({ seq: conversation.lastSeq });
  if (!bumped) throw new Error(`Conversation ${conversationId} not found`);
  await tx.insert(conversationChange).values({ conversationId, seq: bumped.seq, ...change });
  await tx
    .delete(conversationChange)
    .where(
      and(
        eq(conversationChange.conversationId, conversationId),
        lte(conversationChange.seq, bumped.seq - retainedChanges),
      ),
    );
  return bumped.seq;
}

/**
 * The Conversation's changes after seq `since`, oldest first, or `reload` when the log no longer
 * holds them all (`since` is older than its oldest retained change) or `since` is past its newest.
 */
export async function changesSince(
  db: Database,
  conversationId: string,
  since: number,
): Promise<{ reload: true } | { reload: false; changes: LoggedChange[] }> {
  const changes = await db
    .select({
      seq: conversationChange.seq,
      kind: conversationChange.kind,
      refId: conversationChange.refId,
      at: conversationChange.at,
    })
    .from(conversationChange)
    .where(
      and(eq(conversationChange.conversationId, conversationId), gt(conversationChange.seq, since)),
    )
    .orderBy(asc(conversationChange.seq));
  const first = changes[0];
  if (first) return first.seq === since + 1 ? { reload: false, changes } : { reload: true };
  // Nothing after `since`: read after the changes, so a change committed meanwhile only makes the
  // newest seq larger, never a valid cursor look like one from the future.
  const [row] = await db
    .select({ lastSeq: conversation.lastSeq })
    .from(conversation)
    .where(eq(conversation.id, conversationId));
  return since > (row?.lastSeq ?? 0) ? { reload: true } : { reload: false, changes: [] };
}

/**
 * The Conversation's newest seq, the cursor for a client that reads its thread afresh. Read it
 * before the thread: a change committed in between is then replayed onto a thread that may already
 * show it, never missed.
 */
export async function lastSeqOf(db: Database, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ lastSeq: conversation.lastSeq })
    .from(conversation)
    .where(eq(conversation.id, conversationId));
  return row?.lastSeq ?? 0;
}
