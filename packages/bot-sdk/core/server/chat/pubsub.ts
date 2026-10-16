/** Receives one message published on a channel it subscribed to. */
export type PubSubHandler = (message: string) => void;

/**
 * Control signals between processes (ADR 0006), delivered at most once: a message reaches the
 * subscribers present when it is published, and is never replayed. Implementations share the
 * contract in `pubsub.contract.ts`.
 */
export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  /** Resolves once the subscription is in place; the returned function ends it. */
  subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>>;
}

/** The in-process `PubSub`: one process, subscribers held in memory. */
export function createMemoryPubSub(): PubSub {
  // A Set of entry objects, so one handler subscribed twice is still two subscriptions.
  const channels = new Map<string, Set<{ handler: PubSubHandler }>>();

  return {
    async publish(channel, message) {
      // Iterate over a copy: a handler may unsubscribe while the message is being delivered.
      for (const entry of Array.from(channels.get(channel) ?? [])) entry.handler(message);
    },

    async subscribe(channel, handler) {
      const subscribers = channels.get(channel) ?? new Set();
      channels.set(channel, subscribers);
      const entry = { handler };
      subscribers.add(entry);

      return async () => {
        subscribers.delete(entry);
        if (subscribers.size === 0 && channels.get(channel) === subscribers) {
          channels.delete(channel);
        }
      };
    },
  };
}
