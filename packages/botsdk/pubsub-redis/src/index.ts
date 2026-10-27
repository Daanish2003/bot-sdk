import type { BotSdkRuntime } from "@botsdk/bot/runtime";

import { createRedisConnection } from "./redis-connection";
import { createRedisCounters } from "./redis-counters";
import { createRedisPubSub } from "./redis-pubsub";

export { redisStore, type RedisStore } from "./redis-store";

export type RedisRuntimeOptions = {
  /** A `redis://` URL. Nothing connects until the runtime is first used. */
  url: string;
  /** Prepended to every key and channel, so the SDK can share a Redis with the Host's data. */
  prefix?: string;
};

/**
 * The cross-process runtime: signals and rate-limit counters are shared through Redis, so every
 * process of the Host sees them. Use it whenever the Host runs more than one process, including
 * during a zero-downtime deploy.
 */
export function redisRuntime({ url, prefix = "chat:" }: RedisRuntimeOptions): BotSdkRuntime {
  const connection = createRedisConnection(url);
  return {
    pubsub: createRedisPubSub(connection, prefix),
    counters: createRedisCounters(connection, prefix),
    close: connection.close,
  };
}
