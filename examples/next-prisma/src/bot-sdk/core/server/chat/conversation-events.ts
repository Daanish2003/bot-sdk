import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { ChatUser } from "../context";
import { conversation } from "../db/schema";
import type { BotSdkContext } from "../plugin";

/** The pub/sub channel of a Conversation: any plugin publishes its live events here (#290, #625). */
export const conversationChannel = (conversationId: string) => `conversation:${conversationId}`;

/** How often the live stream sends a comment, so an idle connection isn't dropped (#290). */
const heartbeatMs = 25_000;

/**
 * `GET ${basePath}/events?conversationId=…`: the owner's live stream of a Conversation's events
 * (a Bot's Turn hints and its `bot_memory_updated`), as server-sent events, until the page
 * closes it. Never answers a Shared link.
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
        .where(and(eq(conversation.id, id.data), eq(conversation.userId, user.id)))
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
