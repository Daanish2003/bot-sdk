import type { MessagePart } from "@tanstack/ai";

import {
  searchErrorCodes,
  searchLimitError,
  type SearchErrorReason,
  type SearchResult,
  webSearchToolName,
} from "../../../bot/shared/web-search";
import type { WebSearchPart } from "../message-parts";

// Web search's contract lives in the `bot` plugin; the assistant reads it from there until it is deleted.
export * from "../../../bot/shared/web-search";

/**
 * The search a `useChat` part shows, whether it streamed in or came from `toUIParts`; `null`
 * for any other part, a call whose query hasn't streamed in yet, and a call over the per-reply
 * limit.
 */
export function webSearchOf(part: MessagePart): WebSearchPart | null {
  if (part.type !== "tool-call" || part.name !== webSearchToolName) return null;
  const output = part.output as Partial<{
    results: SearchResult[];
    error: string;
    reason: SearchErrorReason;
  }> | null;
  if (output?.error === searchLimitError) return null;
  const query = queryOf(part);
  if (!query && !output) return null;

  const search = { type: "web_search", toolCallId: part.id, query } as const;
  if (Array.isArray(output?.results)) {
    return { ...search, state: "done", results: output.results };
  }
  if (typeof output?.error === "string") {
    return {
      ...search,
      state: "error",
      results: [],
      error: { code: searchErrorCodes[output.reason ?? "failed"] },
    };
  }
  // A call that ended without a result was cancelled.
  return { ...search, state: part.state === "error" ? "cancelled" : "running", results: [] };
}

function queryOf(part: Extract<MessagePart, { type: "tool-call" }>): string {
  const input = (part.input ?? safeParse(part.arguments)) as { query?: unknown } | undefined;
  return typeof input?.query === "string" ? input.query : "";
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
