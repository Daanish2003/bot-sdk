import { createMemoryCounters, type CounterStore } from "./chat/counters";
import { createMemoryPubSub, type PubSub } from "./chat/pubsub";
import { createRedisConnection } from "./chat/redis-connection";
import { createRedisCounters } from "./chat/redis-counters";
import { createRedisPubSub } from "./chat/redis-pubsub";
import { createRedisRunStreams } from "./chat/redis-run-streams";
import { createMemoryRunStreams, type RunStreams } from "./chat/run-streams";

/** What carries Runs across processes (ADR 0006). The Host passes one to `createChat`. */
export type ChatRuntime = {
  /** Every Run's chunk log, which its POST response and any joiner read. */
  runStreams: RunStreams;
  /** Control signals between processes, such as Stop. */
  pubsub: PubSub;
  /** Rate-limit counters, shared by every process of the runtime (spec 87). */
  counters: CounterStore;
  /** Closes the runtime's connections. `stop()` calls it after the drain. */
  close?: () => Promise<void>;
};

/** The in-process runtime: Runs live in this process's memory only. */
export function memoryRuntime(): ChatRuntime {
  return {
    runStreams: createMemoryRunStreams(),
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
 * The cross-process runtime: Runs are shared through Redis, so a Run started on one process can be
 * joined, read and stopped from any other (ADR 0006). Use it whenever Runs can overlap processes,
 * including a zero-downtime deploy.
 */
export function redisRuntime({ url, prefix = "chat:" }: RedisRuntimeOptions): ChatRuntime {
  const connection = createRedisConnection(url);
  return {
    runStreams: createRedisRunStreams(connection, prefix),
    pubsub: createRedisPubSub(connection, prefix),
    counters: createRedisCounters(connection, prefix),
    close: connection.close,
  };
}
