import { createRedisConnection } from "./redis-connection";

/**
 * A string key-value store over Redis, shared by every process that uses the same URL. It serves
 * the Host's own state that must survive a deploy overlap: Better Auth's rate-limit counters
 * and the capture mailbox. Every key is prefixed, so the Host can share a Redis.
 */
export type RedisStore = {
  get(key: string): Promise<string | null>;
  /** Reads a value and deletes it in one step. */
  getAndDelete(key: string): Promise<string | null>;
  /** Stores a value; `ttlSeconds` says when it expires, and omitting it keeps it. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Adds one to the counter at `key` and returns the new value. The counter is created at 1 with
   * `ttlSeconds`; later increments never extend that expiry, so it is a fixed window.
   */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Closes the connections for good. */
  close(): Promise<void>;
};

/** Nothing connects until the store is first used. */
export function redisStore({ url, prefix }: { url: string; prefix: string }): RedisStore {
  const connection = createRedisConnection(url);
  const keyOf = (key: string) => `${prefix}${key}`;

  return {
    async get(key) {
      const client = await connection.command();
      return client.get(keyOf(key));
    },
    async getAndDelete(key) {
      const client = await connection.command();
      const [value] = (await client.multi().get(keyOf(key)).del(keyOf(key)).exec()) as unknown as [
        string | null,
        number,
      ];
      return value;
    },
    async set(key, value, ttlSeconds) {
      const client = await connection.command();
      await client.set(keyOf(key), value, ttlSeconds ? { EX: ttlSeconds } : undefined);
    },
    async delete(key) {
      const client = await connection.command();
      await client.del(keyOf(key));
    },
    async increment(key, ttlSeconds) {
      const client = await connection.command();
      // One MULTI: SET NX opens the window (with its expiry) only when none is open, then INCR counts.
      const [, count] = (await client
        .multi()
        .set(keyOf(key), 0, { EX: ttlSeconds, NX: true })
        .incr(keyOf(key))
        .exec()) as [unknown, number];
      return count;
    },
    close: connection.close,
  };
}
