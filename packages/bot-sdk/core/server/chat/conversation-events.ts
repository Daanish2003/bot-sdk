import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { ChatUser } from "../context";
import type { BotSdkContext } from "../plugin";

/** The pub/sub channel of a Conversation: any plugin publishes its live events here (#290, #625). */
export const conversationChannel = (conversationId: string) => `conversation:${conversationId}`;

/** How often the live stream sends a comment, so an idle connection isn't dropped (#290). */
const heartbeatMs = 25_000;

/**
 * `GET ${basePath}/events?conversationId=…`: the owner's change hints of a Conversation
 * (`conversations.watch`), as server-sent events, until the page closes it.
 */
export async function handleConversationEvents(
  request: Request,
  user: ChatUser,
  deps: BotSdkContext,
): Promise<Response> {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("conversationId"));
  const stop = new AbortController();
  const hints = id.success
    ? await deps.conversations
        .watch({ userId: user.id, conversationId: id.data, signal: stop.signal })
        .catch((error: unknown) => {
          if (error instanceof ORPCError && error.code === "NOT_FOUND") return null;
          throw error;
        })
    : null;
  if (!hints) {
    return Response.json({ code: "error.conversationNotFound", params: {} }, { status: 404 });
  }
  request.signal.addEventListener("abort", () => stop.abort(), { once: true });

  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (open) controller.enqueue(encoder.encode(chunk));
      };
      const heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
      void (async () => {
        try {
          for await (const hint of hints) send(`data: ${JSON.stringify(hint)}\n\n`);
        } finally {
          clearInterval(heartbeat);
          // Throws when the stream was cancelled first, which already closed it.
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          }
        }
      })();
    },
    cancel() {
      open = false;
      stop.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
