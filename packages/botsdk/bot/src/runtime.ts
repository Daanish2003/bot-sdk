import { createMemoryCounters, type CounterStore } from "./chat/counters";
import { createMemoryPubSub, type PubSub } from "./chat/pubsub";

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
