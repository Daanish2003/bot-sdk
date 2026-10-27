import { createMemoryCounters, type CounterStore } from "./chat/counters";
import { createMemoryPubSub, type PubSub } from "./chat/pubsub";
import { createRedisConnection } from "./chat/redis-connection";
import { createRedisCounters } from "./chat/redis-counters";
import { createRedisPubSub } from "./chat/redis-pubsub";

/** What the SDK shares across processes. The Host passes one to `createBotSdk`. */
export type BotSdkRuntime = {
  /** Signals between processes, such as a Conversation's change hints (ADR 0026). */
  pubsub: PubSub;
  /** Rate-limit counters, shared by every process of the runtime (spec 87). */
  counters: CounterStore;
  /** Closes the runtime's connections. `stop()` calls it after the plugins stop. */
  close?: () => Promise<void>;
};

/** The in-process runtime: signals and counters live in this process's memory only. */
export function memoryRuntime(): BotSdkRuntime {
  return {
    pubsub: createMemoryPubSub(),
    counters: createMemoryCounters(),
  };
}

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
