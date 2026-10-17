import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { ChatUser } from "../../../../core/server/context";
import { conversation, memory } from "../../../../core/server/db/schema";
import type { BotSdkContext } from "../../../../core/server/plugin";
import type { MemoryUpdatedEvent, TurnChange } from "../../shared/memory/changes";
import { assistantConversation } from "../chat/kind";

/** The pub/sub channel of a Conversation: its Memory jobs publish here (#290). */
export const conversationChannel = (conversationId: string) => `conversation:${conversationId}`;

/** How often the live stream sends a comment, so an idle connection isn't dropped (#290). */
const heartbeatMs = 25_000;

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

/**
 * `GET ${basePath}/events?conversationId=…`: the owner's live stream of `memory_updated` events for
 * a Conversation, as server-sent events, until the page closes it. Never answers a Shared link.
 */
export async function handleConversationEvents(
  request: Request,
  user: ChatUser,
  deps: BotSdkContext,
): Promise<Response> {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("conversationId"));
  const [owned] = id.success
    ? await deps.db
        .select({ id: conversation.id })
        .from(conversation)
        .where(
          and(
            eq(conversation.id, id.data),
            eq(conversation.userId, user.id),
            assistantConversation(),
          ),
        )
    : [];
  if (!owned) {
    return Response.json({ code: "error.conversationNotFound", params: {} }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const unsubscribe = await deps.pubsub.subscribe(conversationChannel(owned.id), (message) => {
        if (open) controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      });
      const heartbeat = setInterval(() => {
        if (open) controller.enqueue(encoder.encode(": ping\n\n"));
      }, heartbeatMs);
      close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        void unsubscribe();
        // Throws when the stream was cancelled first, which already closed it.
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
