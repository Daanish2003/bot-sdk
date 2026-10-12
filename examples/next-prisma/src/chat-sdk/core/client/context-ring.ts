import type { MessageUsage } from "../shared/chat/message-record";

/** How full the context is: neutral below 80%, amber from 80%, red from 95%. */
export type ContextLevel = "neutral" | "amber" | "red";

export type ContextFill = {
  /** The last Run's input plus output tokens. */
  tokens: number;
  /** The selected Model's window. */
  window: number;
  /** Percent of the window, rounded; can pass 100 when the Conversation no longer fits. */
  percent: number;
  /** The ring's fill, capped at a full ring. */
  fraction: number;
  level: ContextLevel;
  /** The tokens are past the window: earlier Messages are dropped from what's sent. */
  over: boolean;
};

/**
 * The tokens of the last Run on the Active Branch (the newest assistant Message with usage), or
 * `null` when no Run has reported any. `messages` are the Active Branch, oldest first.
 */
export function lastRunTokens(
  messages: ReadonlyArray<{ role: "user" | "assistant"; usage: MessageUsage | null }>,
): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant" && message.usage) {
      return message.usage.input + message.usage.output;
    }
  }
  return null;
}

/**
 * The ring's reading for `tokens` against the selected Model's `window`; `null` when there's no
 * Run yet (`tokens`) or the window is unknown.
 */
export function contextFill(tokens: number | null, window: number | null): ContextFill | null {
  if (tokens === null || window === null || window <= 0) return null;
  const ratio = tokens / window;
  const level: ContextLevel = ratio >= 0.95 ? "red" : ratio >= 0.8 ? "amber" : "neutral";
  return {
    tokens,
    window,
    percent: Math.round(ratio * 100),
    fraction: Math.min(ratio, 1),
    level,
    over: tokens > window,
  };
}
