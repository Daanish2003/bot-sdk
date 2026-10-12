import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";
import { type CompactionInfo, evictOldest, withCompaction } from "@tanstack/ai-compaction";

/** Tokens kept back from the window for what the Run adds around the Messages (system prompts, tools). */
export const contextMarginTokens = 2_000;

/** What one image or PDF counts for, whatever its encoded size (a base64 file would count as text). */
export const attachmentTokens = 1_600;

/**
 * The tokens a Run may send to a Model: its window, less the reply's max output and a margin. When
 * the max output leaves no room at all, half the window instead. Null when the window is unknown, so
 * nothing is compacted and the Run sends everything.
 */
export function contextBudgetOf({
  contextWindow,
  maxOutputTokens,
}: {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}): number | null {
  if (contextWindow === null) return null;
  const reserved = contextWindow - (maxOutputTokens ?? 0) - contextMarginTokens;
  // A max output as big as the window would leave the input nothing, and every Run would be refused.
  // Only then does the input keep half the window; otherwise the spec's formula stands unchanged.
  return reserved > 0 ? reserved : Math.floor(contextWindow / 2);
}

const isAttachment = (part: unknown) =>
  typeof part === "object" &&
  part !== null &&
  ((part as { type?: unknown }).type === "image" ||
    (part as { type?: unknown }).type === "document");

/**
 * The tokens one model message takes: about a quarter of its JSON per token, as the default
 * estimator counts, except that an image or PDF counts as `attachmentTokens`.
 */
export function estimateModelMessageTokens(message: ModelMessage): number {
  const { content, ...rest } = message;
  const parts: unknown[] = Array.isArray(content) ? content : [content];
  const attachments = parts.filter(isAttachment).length;
  const text = JSON.stringify({ ...rest, content: parts.filter((part) => !isAttachment(part)) });
  return Math.ceil(text.length / 4) + attachments * attachmentTokens;
}

/**
 * The compaction of one Run: the middleware that drops the oldest Messages from what each model
 * call sends, and the context start it records (the first stored Message the Model saw).
 *
 * `owners[i]` is the stored Message that the i-th model message came from. The middleware counts
 * only, so the start is derived from them (see the #115 tracer). A cut past the stored history is
 * the Run's own Message, so it records `reply`.
 */
export function compactionFor({
  budget,
  owners,
  reply,
}: {
  budget: number;
  owners: string[];
  reply: string;
}): { middleware: ChatMiddleware; contextStartId: () => string | null } {
  let contextStart: string | null = null;
  const middleware = withCompaction({
    maxTokens: budget,
    strategy: evictOldest({ keepRecentTokens: budget }),
    estimateTokens: estimateModelMessageTokens,
    onCompact: (info: CompactionInfo) => {
      // The marker is the one message evictOldest prepends, so this is the first kept index.
      const first = info.messagesBefore - (info.messagesAfter - 1);
      // Cuts only move forward as the Run adds messages, so the latest one is the Model's start.
      contextStart = owners[first] ?? reply;
    },
  });
  return { middleware, contextStartId: () => contextStart };
}
