import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { conversationChannel } from "../../../core/server/chat/conversation-events";
import type { PubSub } from "../../../core/server/chat/pubsub";
import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput, rpcError } from "../../../core/server/rpc-error";
import { conversation } from "../../../core/server/storage";
import { conversationChanges } from "./changes";

/*
 * The `conversations` namespace's domain methods (spec #873), taking the user's id as `bots` does.
 * A Conversation's live signal is a data-less change hint; what changed is read with `changes`
 * (ADR 0026).
 */

/** `conversations.watch`'s input, besides `userId` and `signal`. */
export const watchInput = z.object({ conversationId: z.uuid() });

/** `conversations.changes`' input, besides `userId`. */
export const changesInput = z.object({
  conversationId: z.uuid(),
  since: z.number().int().min(0),
});

/** A change hint: something in the Conversation's thread changed. It carries no data. */
export type ConversationHint = { type: "changed" };

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The `conversations` namespace over the core context. */
export function conversationsApi(sdk: BotSdkContext) {
  return {
    /**
     * The user's Conversation's change hints, from now until `signal` aborts or the caller stops
     * iterating. It resolves once the subscription is in place, so `changes` read after it misses
     * no change. Hints are delivered at most once, to watchers present when they are sent. Pass a
     * `signal` unless the hints are always iterated: the subscription holds until one of them ends
     * it. Another user's Conversation is not found.
     */
    watch: async ({
      userId,
      signal,
      ...rest
    }: WithUser<typeof watchInput> & { signal?: AbortSignal }): Promise<
      AsyncIterable<ConversationHint>
    > => {
      const { conversationId } = parseInput(watchInput, rest);
      const [owned] = await sdk.db
        .select({ id: conversation.id })
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)));
      if (!owned) {
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
      }
      return subscribeHints(sdk.pubsub, conversationChannel(conversationId), signal);
    },

    /**
     * The changes to the user's Bot Conversation's thread after seq `since` (ADR 0026), oldest
     * first, each with what it points at as it is now (`data`, null once that is gone): a Message
     * appended or changed, a Turn's status, a Secret saved, a Routine, review, Helper or Check-in
     * changed. A cursor the change log no longer holds, or one past its newest change, gets
     * `reload`: read the thread afresh with `bots.get`. Another user's Conversation is not found.
     */
    changes: async ({ userId, ...rest }: WithUser<typeof changesInput>) => {
      const { conversationId, since } = parseInput(changesInput, rest);
      return conversationChanges(sdk, userId, conversationId, since);
    },
  };
}

/** The `conversations` namespace's domain methods. */
export type ConversationsApi = ReturnType<typeof conversationsApi>;

/**
 * The hints published on `channel`, buffered from the moment this resolves. The subscription ends
 * when `signal` aborts or the iteration ends, whichever is first.
 */
async function subscribeHints(
  pubsub: PubSub,
  channel: string,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<ConversationHint>> {
  const queued: ConversationHint[] = [];
  let wake: (() => void) | undefined;
  let open = true;
  const unsubscribe = await pubsub.subscribe(channel, (message) => {
    if (!open) return;
    queued.push(JSON.parse(message) as ConversationHint);
    wake?.();
  });
  const close = () => {
    if (!open) return;
    open = false;
    signal?.removeEventListener("abort", close);
    void unsubscribe();
    wake?.();
  };
  if (signal?.aborted) close();
  else signal?.addEventListener("abort", close, { once: true });

  async function* read(): AsyncGenerator<ConversationHint> {
    try {
      for (;;) {
        while (queued.length > 0) yield queued.shift()!;
        if (!open) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      close();
    }
  }
  return {
    [Symbol.asyncIterator]: () => {
      const hints = read();
      // A generator never started skips its `finally` on `return`: this ends the subscription too.
      return {
        next: () => hints.next(),
        return: (value?: unknown) => {
          close();
          return hints.return(value as undefined);
        },
      };
    },
  };
}
