import {
  EventType,
  fromSpecTokenUsage,
  type ModelMessage,
  type StreamChunk,
  type TokenUsage,
} from "@tanstack/ai";

import type { MessageUsage } from "../shared/usage";

/** Providers that report input without its cache reads and writes, so those are added back. */
const cacheApartProviders = new Set(["anthropic", "bedrock"]);

/** A Run's usage so far, with input including cached tokens. */
export type RunUsage = Omit<MessageUsage, "estimated">;

/** One model iteration's usage as `RUN_FINISHED` reports it, normalised across Providers. */
export function normalizeUsage(provider: string, usage: TokenUsage): RunUsage {
  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  const cacheWritten = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
  const cacheApart = cacheApartProviders.has(provider);
  return {
    input: usage.promptTokens + (cacheApart ? cached + cacheWritten : 0),
    output: usage.completionTokens,
    reasoning: usage.completionTokensDetails?.reasoningTokens ?? 0,
    cached,
  };
}

/** Adds one model iteration's usage to the Run's total. */
export function addUsage(total: RunUsage | undefined, next: RunUsage): RunUsage {
  if (!total) return next;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    reasoning: total.reasoning + next.reasoning,
    cached: total.cached + next.cached,
  };
}

/**
 * The usage and the Provider's reported cost of a call that returned its chunks whole (a title).
 * Summed over its `RUN_FINISHED` chunks as a Run's are; the cost only when every one reports one.
 */
export function reportedUsageOf(
  provider: string,
  chunks: StreamChunk[],
): { usage?: RunUsage; cost?: number } {
  let usage: RunUsage | undefined;
  let cost: number | undefined;
  let costComplete = true;
  for (const chunk of chunks) {
    if (chunk.type !== EventType.RUN_FINISHED || !chunk.usage) continue;
    // The AG-UI array form is converted back to TanStack's shape first.
    const tokens = Array.isArray(chunk.usage) ? fromSpecTokenUsage(chunk.usage) : chunk.usage;
    if (!tokens) continue;
    usage = addUsage(usage, normalizeUsage(provider, tokens));
    if (tokens.cost === undefined) costComplete = false;
    else cost = (cost ?? 0) + tokens.cost;
  }
  return { usage, cost: costComplete ? cost : undefined };
}

/** Characters of text a Run sent the Model: string content and text parts. */
export function promptCharactersOf(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    const { content } = message;
    if (typeof content === "string") return total + content.length;
    if (!Array.isArray(content)) return total;
    return (
      total +
      content.reduce((sum, part) => sum + (part.type === "text" ? part.content.length : 0), 0)
    );
  }, 0);
}
