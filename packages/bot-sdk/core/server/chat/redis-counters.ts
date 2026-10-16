import type { CounterHit, CounterStore } from "./counters";
import type { RedisConnection } from "./redis-connection";

/**
 * `CounterStore` over Redis (spec 87): one key per counter, which expires when its window ends, so
 * limits hold across processes and nothing is left behind. Keys are prefixed like every other key
 * the SDK writes.
 */
export function createRedisCounters(connection: RedisConnection, prefix: string): CounterStore {
  return {
    async hit(key, windowMs): Promise<CounterHit> {
      const client = await connection.command();
      const redisKey = `${prefix}counter:${key}`;
      // One MULTI: SET NX opens the window (with its expiry) only when none is open, then INCR
      // counts this hit and PTTL says how long the window has left.
      const [, count, ttl] = (await client
        .multi()
        .set(redisKey, 0, { PX: windowMs, NX: true })
        .incr(redisKey)
        .pTTL(redisKey)
        .exec()) as [unknown, number, number];
      return { count, resetMs: ttl > 0 ? ttl : windowMs };
    },
  };
}
