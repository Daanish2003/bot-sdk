import type { Logger } from "../create-chat";

/** One `chat.usage` row, as the SDK wrote it (ADR 0007). */
export type UsageEvent = {
  id: string;
  userId: string;
  kind: "run" | "title" | "web_search";
  /** The `"provider:model"` id, or `"tavily"` for a web search. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The cost in millionths of a US dollar. */
  costMicros: number;
  estimated: boolean;
  createdAt: Date;
};

/**
 * The Host's callbacks into the SDK (`createChat({ hooks })`). Every one is optional. A hook is
 * called after its change is written, never awaited, at most once, and never retried; one that
 * throws or rejects is logged through the Host's `logger`.
 */
export type ChatHooks = {
  /** Fires after each usage row on Host credentials is written: a Run, a title or a web search. */
  onUsage?: (usage: UsageEvent) => unknown;
};

type HookName = keyof ChatHooks;
type HookPayload<K extends HookName> = Parameters<NonNullable<ChatHooks[K]>>[0];

/** Calls the Host's hooks. Used by the SDK after each change it writes. */
export type HookEmitter = {
  fire: <K extends HookName>(name: K, payload: HookPayload<K>) => void;
};

/** The emitter for a Host's hooks; a missing hook is a no-op. */
export function createHookEmitter(hooks: ChatHooks | undefined, logger: Logger): HookEmitter {
  return {
    fire(name, payload) {
      if (!hooks?.[name]) return;
      // Started a microtask later, so a sync throw and an async rejection both land in `catch`.
      // Called as a method of `hooks`, so a hook that uses `this` keeps it.
      void Promise.resolve()
        .then(() => (hooks[name] as (payload: unknown) => unknown)(payload))
        .catch((error: unknown) => logger.error(`The Host's ${name} hook failed`, error));
    },
  };
}
