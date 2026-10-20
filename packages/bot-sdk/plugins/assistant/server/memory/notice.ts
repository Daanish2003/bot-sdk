import { asc, inArray } from "drizzle-orm";

import { conversationChannel } from "../../../../core/server/chat/conversation-events";
import { memory } from "../../../../core/server/db/schema";
import type { BotSdkContext } from "../../../../core/server/plugin";
import type { MemoryUpdatedEvent, TurnChange } from "../../shared/memory/changes";

/**
 * Publishes a turn's changes on the Conversation's channel, after they are written. Never throws:
 * the Memories are already saved, and a missed notice only means the chip shows on reload.
 */
export async function publishMemoryUpdated(
  deps: Pick<BotSdkContext, "pubsub" | "logger">,
  conversationId: string,
  event: MemoryUpdatedEvent,
): Promise<void> {
  try {
    await deps.pubsub.publish(conversationChannel(conversationId), JSON.stringify(event));
  } catch (error) {
    deps.logger.error(`Publishing the Memory changes of ${event.messageId} failed`, error);
  }
}

/**
 * The changes each turn made, worked out from the Memories its user Message made (#290): an
 * added Memory is one with no invalid Memory replaced by it; an updated one names the old text.
 * Forgets leave no row, so they are not derived. Keyed by the user Message's id.
 */
export async function turnChangesOf(
  deps: Pick<BotSdkContext, "db">,
  userMessageIds: string[],
): Promise<Map<string, TurnChange[]>> {
  const changes = new Map<string, TurnChange[]>();
  if (userMessageIds.length === 0) return changes;
  const made = await deps.db
    .select({ id: memory.id, text: memory.text, sourceMessageId: memory.sourceMessageId })
    .from(memory)
    .where(inArray(memory.sourceMessageId, userMessageIds))
    .orderBy(asc(memory.createdAt));
  if (made.length === 0) return changes;
  const replaced = await deps.db
    .select({ text: memory.text, replacedById: memory.replacedById })
    .from(memory)
    .where(
      inArray(
        memory.replacedById,
        made.map((row) => row.id),
      ),
    );
  const oldTextOf = new Map(replaced.map((row) => [row.replacedById, row.text]));
  for (const row of made) {
    const from = oldTextOf.get(row.id);
    const change: TurnChange =
      from === undefined
        ? { kind: "added", memoryId: row.id, text: row.text }
        : { kind: "updated", memoryId: row.id, from, text: row.text };
    changes.set(row.sourceMessageId, [...(changes.get(row.sourceMessageId) ?? []), change]);
  }
  return changes;
}
