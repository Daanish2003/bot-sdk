import type { PubSub } from "./pubsub";
import type { RedisConnection } from "./redis-connection";

/**
 * `PubSub` over Redis pub/sub (ADR 0006): at most once, with each subscription's handler on the
 * process's one subscriber connection. Channels are prefixed, so runtimes with different prefixes
 * sharing one Redis never see each other's signals.
 */
export function createRedisPubSub(connection: RedisConnection, prefix: string): PubSub {
  return {
    async publish(channel, message) {
      const client = await connection.command();
      await client.publish(`${prefix}${channel}`, message);
    },

    async subscribe(channel, handler) {
      const subscriber = await connection.subscriber();
      const key = `${prefix}${channel}`;
      const listener = (message: string) => handler(message);
      await subscriber.subscribe(key, listener);

      return async () => {
        // A subscription that outlived `close()` went with its connection.
        if (subscriber.isOpen) await subscriber.unsubscribe(key, listener);
      };
    },
  };
}
