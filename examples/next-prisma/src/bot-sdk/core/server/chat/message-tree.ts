import { eq } from "drizzle-orm";

import { pathTo } from "../../shared/chat/branches";
import { searchTextOf } from "../../shared/message-parts";
import { conversation, message, type MessageRow } from "../db/schema";
import { uuidv7 } from "../lib/uuidv7";
import { recordChange } from "./change-log";
import type { BotSdkContext, Transaction } from "../plugin";

type MessageInsert = typeof message.$inferInsert;

type Deps = Pick<BotSdkContext, "db">;

/** Every Message of the Conversation, on every Branch, in no order. */
export function loadMessages(deps: Deps, conversationId: string) {
  return deps.db.select().from(message).where(eq(message.conversationId, conversationId));
}

/** The Messages from a root down to `leafId`, oldest first. Empty without a leaf. */
export async function loadPath(
  deps: Deps,
  conversationId: string,
  leafId: string | null,
): Promise<MessageRow[]> {
  if (!leafId) return [];
  return pathTo(await loadMessages(deps, conversationId), leafId);
}

/**
 * Appends one Message at the Conversation's `activeLeafId`, under the Conversation's row lock, and
 * makes it the new leaf, with a `message` change in its change log (ADR 0026). Call it inside a
 * transaction, so the lock holds until the commit.
 */
export async function appendMessage(
  tx: Transaction,
  conversationId: string,
  fields: Pick<MessageInsert, "role" | "parts" | "status" | "createdAt"> & { id?: string },
): Promise<MessageRow> {
  const [owner] = await tx
    .select({ activeLeafId: conversation.activeLeafId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .for("update");
  if (!owner) throw new Error(`Conversation ${conversationId} not found`);
  const [row] = await tx
    .insert(message)
    .values({
      conversationId,
      parentId: owner.activeLeafId,
      searchText: searchTextOf(fields.parts),
      ...fields,
      id: fields.id ?? uuidv7(),
    })
    .returning();
  if (!row) throw new Error("Appending the Message returned no row");
  await tx
    .update(conversation)
    .set({ activeLeafId: row.id, lastMessageAt: row.createdAt })
    .where(eq(conversation.id, conversationId));
  await recordChange(tx, conversationId, { kind: "message", refId: row.id, at: row.createdAt });
  return row;
}
