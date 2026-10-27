import { createClient, type RedisClientType } from "redis";

/**
 * The Redis connections one process shares (ADR 0006): one command connection for reads, writes
 * and publishes, and one dedicated subscriber connection, however many Runs are live. Each opens
 * on first use, so building one connects to nothing.
 */
export type RedisConnection = {
  command: () => Promise<RedisClientType>;
  subscriber: () => Promise<RedisClientType>;
  /** Closes both connections for good: any later use rejects, so nothing reopens after `stop()`. */
  close: () => Promise<void>;
};

export function createRedisConnection(url: string): RedisConnection {
  const commandClient = createClient({ url });
  const subscriberClient = commandClient.duplicate();
  for (const client of [commandClient, subscriberClient]) {
    client.on("error", (error: unknown) => console.error("Redis connection error", error));
  }

  let closed = false;

  // The first use opens the client. A failed open is forgotten, so the next use tries again.
  const opener = (client: RedisClientType) => {
    let opened: Promise<RedisClientType> | undefined;
    return () => {
      if (closed) return Promise.reject(new Error("The Redis connection is closed"));
      opened ??= client.connect().catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
      return opened;
    };
  };

  const closeClient = (client: RedisClientType) => {
    if (client.isReady) return client.close();
    // Still connecting or never opened: nothing to drain, and a pending handshake must not hold up stop().
    if (client.isOpen) client.destroy();
    return Promise.resolve();
  };

  return {
    command: opener(commandClient),
    subscriber: opener(subscriberClient),
    close: async () => {
      closed = true;
      await Promise.all([closeClient(commandClient), closeClient(subscriberClient)]);
    },
  };
}
