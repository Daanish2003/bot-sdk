import type { Logger } from "../create-chat";

/**
 * The sha256 of one section of a Bot's prompt, as one model call sent it (#670): `tools`, each
 * system block, `first_message`, then `history`, the messages after the first one.
 */
export type PromptHash = {
  name: string;
  hash: string;
  /** An estimate of the section's size (characters / 4), to draw the prompt bar (#675). */
  tokens?: number;
  /** For `history`: how many messages it covers, so the next call can hash the same ones. */
  messages?: number;
  /**
   * On the first section that differs from the call before: `bug` when the Prompt start is the
   * same, so the cache missed before the newest message; `expected` right after a new Prompt start.
   * On `history`, it is the messages the call before sent that differ.
   */
  changed?: "bug" | "expected";
};

/** One `chat.usage` row, as the SDK wrote it (ADR 0007). */
export type UsageEvent = {
  id: string;
  userId: string;
  kind:
    | "run"
    | "title"
    | "web_search"
    | "transcription"
    | "image"
    | "memory"
    | "turn"
    | "helper"
    | "summary"
    | "warm"
    | "review"
    | "skill_draft";
  /** The `"provider:model"` id, `"tavily"` for a web search, or the transcription or image model's id. */
  model: string;
  /** Every input token, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** The input tokens read from the Provider's prompt cache. */
  cacheReadTokens: number;
  /** The input tokens written to the Provider's prompt cache. */
  cacheWriteTokens: number;
  /** The Bot Turn or Helper (or, for warming, the Bot) a Model call was made for, else `null`. */
  sourceId: string | null;
  /** The hash of each section of the prompt a Model call sent, else `null`. */
  promptHashes: PromptHash[] | null;
  /** The cost in millionths of a US dollar. */
  costMicros: number;
  estimated: boolean;
  createdAt: Date;
};

/** A Conversation the core's delete removed and announced. */
export type ConversationDeletedEvent = {
  userId: string;
  conversationId: string;
};

/**
 * The Host's callbacks into the SDK (`createBotSdk({ hooks })`). Every one is optional. An event hook
 * is called after its change is written, never awaited, at most once, and never retried; one that
 * throws or rejects is logged through the Host's `logger`.
 */
export type EventHooks = {
  /**
   * Fires after each usage row is written: a call on Host credentials (a web search, a transcription,
   * a generated image, a Bot's Turn or Helper), or, at `costMicros` 0, a generated image or a Bot's
   * model call on the user's own key or linked plan (#667).
   */
  onUsage?: (usage: UsageEvent) => unknown;
  /** Fires once for each Conversation the core's delete removes with `announce` (#266). */
  onConversationDeleted?: (conversation: ConversationDeletedEvent) => unknown;
};

type HookName = keyof EventHooks;
type HookPayload<K extends HookName> = Parameters<NonNullable<EventHooks[K]>>[0];

/** Calls the Host's hooks. Used by the SDK after each change it writes. */
export type HookEmitter = {
  fire: <K extends HookName>(name: K, payload: HookPayload<K>) => void;
};

/** The emitter for a Host's hooks; a missing hook is a no-op. */
export function createHookEmitter(hooks: EventHooks | undefined, logger: Logger): HookEmitter {
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
